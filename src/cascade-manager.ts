/**
 * Cascade Manager
 *
 * Coordinates Cascade lifecycles, turn execution, and history synchronization (revertToCascadeStep).
 */

import type { Cascade } from "antigravity-client";
import type { LsConnection } from "./ls-connection.js";
import { BindingStore, type SessionBinding } from "./bindings.js";
import { buildCascadeConfig } from "./cascade-config.js";

export interface TurnContext {
  sessionId: string;
  branch: Array<{ id: string; [key: string]: any }>;
  modelId: number;
  systemPrompt: string;
}

export class CascadeManager {
  private activeCascades = new Map<string, Cascade>();

  constructor(
    private lsConnection: LsConnection,
    private bindingStore = new BindingStore(),
    private verbose = false
  ) {}

  /**
   * Prepares and synchronizes a Cascade for the upcoming turn.
   * Handles history rewinding via revertToCascadeStep when branch diversion is detected.
   */
  async ensureTurnCascade(ctx: TurnContext): Promise<Cascade> {
    const { sessionId, branch, modelId, systemPrompt } = ctx;
    const client = await this.lsConnection.ensureClient();
    const binding = this.bindingStore.get(sessionId);

    const currentLeafId = branch.length > 0 ? branch[branch.length - 1].id : "";

    let cascade: Cascade | null = null;

    if (binding?.cascadeId) {
      try {
        cascade = await client.resumeCascade(binding.cascadeId);
      } catch (e: any) {
        if (this.verbose) {
          console.error(`[CascadeManager] Could not resume cascade ${binding.cascadeId}: ${e.message}`);
        }
        cascade = null;
      }
    }

    if (cascade && binding) {
      // Check for history rewind or divergence
      if (binding.lastLeafId && binding.lastLeafId !== currentLeafId) {
        if (this.verbose) {
          console.error(
            `[CascadeManager] Branch divergence detected! lastLeafId=${binding.lastLeafId}, currentLeafId=${currentLeafId}`
          );
        }

        // Find the most recent entry in the current branch that exists in our binding steps
        let targetEntryId: string | null = null;
        let targetStepIndex: number | null = null;

        for (let i = branch.length - 1; i >= 0; i--) {
          const entryId = branch[i].id;
          if (typeof binding.steps[entryId] === "number") {
            targetEntryId = entryId;
            targetStepIndex = binding.steps[entryId];
            break;
          }
        }

        if (targetEntryId !== null && targetStepIndex !== null) {
          if (this.verbose) {
            console.error(
              `[CascadeManager] Reverting cascade ${binding.cascadeId} to stepIndex ${targetStepIndex} (entry ${targetEntryId})`
            );
          }

          try {
            await client.lsClient.revertToCascadeStep({
              cascadeId: binding.cascadeId,
              stepIndex: targetStepIndex,
              overrideConfig: buildCascadeConfig({ modelId, systemPrompt }),
            });

            // Clean up steps after targetEntryId
            const validEntryIds = new Set(branch.map((b) => b.id));
            const newSteps: Record<string, number> = {};
            for (const [eid, sidx] of Object.entries(binding.steps)) {
              if (validEntryIds.has(eid) && sidx <= targetStepIndex) {
                newSteps[eid] = sidx;
              }
            }

            binding.lastLeafId = targetEntryId;
            binding.steps = newSteps;
            this.bindingStore.set(sessionId, binding);
          } catch (err: any) {
            console.error(`[CascadeManager] Failed to revert cascade: ${err.message}. Starting fresh.`);
            cascade = null;
          }
        } else {
          // No common ancestor found in this cascade; start a new cascade
          cascade = null;
        }
      }
    }

    if (!cascade) {
      if (this.verbose) {
        console.error(`[CascadeManager] Starting fresh cascade for session ${sessionId}`);
      }
      cascade = await client.startCascade();

      this.bindingStore.set(sessionId, {
        cascadeId: cascade.cascadeId,
        lastLeafId: currentLeafId,
        steps: {},
      });
    }

    // Attach auto-approval for MCP tool permissions
    this.attachAutoApproval(cascade);
    this.activeCascades.set(sessionId, cascade);

    return cascade;
  }

  private attachAutoApproval(cascade: Cascade): void {
    cascade.on("interaction", async (req: any) => {
      if (this.verbose) {
        console.error(`[CascadeManager] Interaction on step ${req.stepIndex}: ${req.type} - ${req.description}`);
      }
      try {
        await req.approve("conversation");
        if (this.verbose) {
          console.error(`[CascadeManager] Auto-approved interaction on step ${req.stepIndex}`);
        }
      } catch (err: any) {
        console.error(`[CascadeManager] Failed to auto-approve interaction: ${err.message}`);
      }
    });
  }

  /**
   * Records the completion of a turn, mapping the new leaf entry ID to the trajectory step count.
   */
  async recordTurnEnd(sessionId: string, newLeafId: string, cascade: Cascade): Promise<void> {
    const binding = this.bindingStore.get(sessionId);
    if (!binding) return;

    try {
      const hist = await cascade.getHistory();
      const stepCount = hist.trajectory?.steps?.length ?? 0;

      binding.lastLeafId = newLeafId;
      binding.steps[newLeafId] = stepCount;
      this.bindingStore.set(sessionId, binding);

      if (this.verbose) {
        console.error(
          `[CascadeManager] Recorded turn end: session=${sessionId}, leafId=${newLeafId}, steps=${stepCount}`
        );
      }
    } catch (e: any) {
      if (this.verbose) {
        console.error(`[CascadeManager] Failed to record turn end: ${e.message}`);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.bindingStore.remove(sessionId);
    const cascade = this.activeCascades.get(sessionId);
    if (cascade) {
      try {
        cascade.dispose();
      } catch {
        // ignore
      }
      this.activeCascades.delete(sessionId);
    }
  }

  clearAll(): void {
    this.bindingStore.clear();
    for (const cascade of this.activeCascades.values()) {
      try {
        cascade.dispose();
      } catch {
        // ignore
      }
    }
    this.activeCascades.clear();
  }
}
