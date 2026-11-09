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
  modelName?: string;
  systemPrompt: string;
  mcpServerName?: string;
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
   * Reuses in-memory Cascade if active, or resumes from binding on session start.
   * Handles history rewinding via revertToCascadeStep when branch diversion is detected.
   */
  async ensureTurnCascade(ctx: TurnContext): Promise<Cascade> {
    const { sessionId, branch, modelId, modelName, systemPrompt } = ctx;
    const client = await this.lsConnection.ensureClient();
    const binding = this.bindingStore.get(sessionId);

    const currentLeafId = branch.length > 0 ? branch[branch.length - 1].id : "";

    // 1. Prefer existing in-memory Cascade instance for this session (avoid repeat id subscriptions)
    let cascade: Cascade | null = this.activeCascades.get(sessionId) || null;

    // 2. If not in memory (e.g. fresh pi restart), resume from stored binding
    if (!cascade && binding?.cascadeId) {
      try {
        cascade = await client.resumeCascade(binding.cascadeId);
        this.attachListeners(cascade);
        this.activeCascades.set(sessionId, cascade);
      } catch (e: any) {
        if (this.verbose) {
          console.error(`[CascadeManager] Could not resume cascade ${binding.cascadeId}: ${e.message}`);
        }
        cascade = null;
      }
    }

    if (cascade && binding) {
      // Check for history rewind or divergence:
      // If the previous turn's leaf still exists anywhere in the current branch, we are continuing normally.
      // If it does NOT exist, the branch was rewound / forked to a past point!
      const branchEntryIds = new Set(branch.map((b) => b.id));
      const isRewound = Boolean(binding.lastLeafId && !branchEntryIds.has(binding.lastLeafId));

      if (isRewound) {
        if (this.verbose) {
          console.error(
            `[CascadeManager] History rewind detected! previousLeafId=${binding.lastLeafId} not in branch.`
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
              overrideConfig: buildCascadeConfig({ modelId, modelName, systemPrompt, mcpServerName: ctx.mcpServerName }),
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
            this.disposeCascade(sessionId);
            cascade = null;
          }
        } else {
          // No common ancestor found in this cascade; start a new cascade
          this.disposeCascade(sessionId);
          cascade = null;
        }
      }
    }

    if (!cascade) {
      this.disposeCascade(sessionId);

      if (this.verbose) {
        console.error(`[CascadeManager] Starting fresh cascade for session ${sessionId}`);
      }
      cascade = await client.startCascade();

      this.bindingStore.set(sessionId, {
        cascadeId: cascade.cascadeId,
        lastLeafId: currentLeafId,
        steps: {},
      });

      this.attachListeners(cascade);
      this.activeCascades.set(sessionId, cascade);
    }

    return cascade;
  }

  private attachListeners(cascade: Cascade): void {
    // 1. Enforce approval gate: ALLOW pi-tools MCP calls, DENY all Antigravity builtins
    cascade.on("interaction", async (req: any) => {
      const desc = req.description || "";
      const rawCase = req.raw?.requestedInteraction?.interaction?.case;
      const isMcp =
        req.type === "mcp" ||
        desc.includes("pi-tools") ||
        (rawCase === "permission" && desc.includes("pi-tools"));

      if (isMcp) {
        if (this.verbose) {
          console.error(`[CascadeManager] Auto-approving MCP interaction on step ${req.stepIndex}: ${desc}`);
        }
        try {
          await req.approve("conversation");
        } catch (err: any) {
          console.error(`[CascadeManager] Failed to approve MCP interaction: ${err.message}`);
        }
      } else {
        // Built-in tool detected (read_file, run_command, etc.) — STRICTLY DENY!
        console.warn(
          `[CascadeManager] Blocked Antigravity builtin tool interaction on step ${req.stepIndex}: ${desc}`
        );
        try {
          await req.deny();
        } catch (err: any) {
          console.error(`[CascadeManager] Failed to deny builtin interaction: ${err.message}`);
        }
      }
    });

    // 2. Safe error handler to prevent uncaughtException crash
    cascade.on("error", (err: any) => {
      const msg = err?.message || String(err);
      if (msg.includes("subscription closed by repeat id") || err?.code === 1) {
        // Expected when a subscription is superseded or reset
        return;
      }
      if (this.verbose) {
        console.error(`[CascadeManager] Stream error (non-fatal): ${msg}`);
      }
    });
  }

  private disposeCascade(sessionId: string): void {
    const old = this.activeCascades.get(sessionId);
    if (old) {
      try {
        old.dispose();
      } catch {
        // ignore
      }
      this.activeCascades.delete(sessionId);
    }
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

  getActiveCascade(sessionId: string): Cascade | undefined {
    return this.activeCascades.get(sessionId);
  }

  /**
   * Explicitly cancels any active invocation for the session's Cascade,
   * deterministically forcing LS into `idle` state. (D-03)
   */
  async cancelCascade(sessionId: string): Promise<void> {
    const cascade = this.activeCascades.get(sessionId);
    if (!cascade) return;

    try {
      await cascade.cancel();
    } catch (err: any) {
      if (this.verbose) {
        console.error(`[CascadeManager] Failed to cancel cascade ${cascade.cascadeId}:`, err?.message);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.bindingStore.remove(sessionId);
    this.disposeCascade(sessionId);
  }

  clearAll(): void {
    this.bindingStore.clear();
    for (const [sessionId] of this.activeCascades) {
      this.disposeCascade(sessionId);
    }
  }
}
