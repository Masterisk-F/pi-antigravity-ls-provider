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
  branch: Array<{ id?: string; role?: string; timestamp?: number; [key: string]: any }>;
  modelId: number;
  modelName?: string;
  systemPrompt: string;
  mcpServerName?: string;
  /**
   * Serialized transcript of every message that precedes the current turn.
   * Injected into the Cascade config when a fresh Cascade is started, because a
   * new Cascade has no trajectory of its own to reason from.
   */
  priorHistory?: string;
  /**
   * True when the previous assistant turn belongs to a different provider, meaning
   * the current Cascade can never have seen the turns that happened in between.
   */
  isExternalSwitch?: boolean;
}

export interface TurnCascade {
  cascade: Cascade;
  /** History transcript the Language Server must receive for this turn ("" when none). */
  priorHistory: string;
}

export interface RecordTurnEndOptions {
  branch?: Array<{ id?: string; role?: string; timestamp?: number; content?: any; toolCallId?: string; [key: string]: any }>;
  assistantMessage?: { id?: string; role?: string; timestamp?: number; content?: any; [key: string]: any };
}

export function getEntryPrimaryKey(
  entry: { id?: string; role?: string; timestamp?: number } | undefined,
  position: number
): string {
  if (entry?.id) return entry.id;
  if (entry) {
    return `${entry.role ?? "unknown"}:${entry.timestamp ?? 0}:${position}`;
  }
  return `leaf:${position}`;
}

/**
 * Returns all candidate lookup keys for a branch entry at 0-based index `index`.
 * Supporting multiple deterministic keys (entry ID, positional key, toolCallId, and
 * parent-relative assistant key) ensures rewind targets resolve accurately across
 * intermediate tool calls, final assistant turns, and synthetic test messages.
 */
export function getBranchEntryKeys(
  branch: Array<{ id?: string; role?: string; timestamp?: number; content?: any; toolCallId?: string; [key: string]: any }>,
  index: number
): string[] {
  const entry = branch[index];
  if (!entry) return [];

  const pos = index + 1;
  const keys: string[] = [];
  const primary = getEntryPrimaryKey(entry, pos);
  keys.push(primary);

  const positional = `${entry.role ?? "unknown"}:${entry.timestamp ?? 0}:${pos}`;
  if (positional !== primary) {
    keys.push(positional);
  }

  // Position-independent timestamp key when timestamp is a valid positive number (D-04)
  if (typeof entry.timestamp === "number" && entry.timestamp > 0) {
    const timeKey = `${entry.role ?? "unknown"}:${entry.timestamp}`;
    if (!keys.includes(timeKey)) {
      keys.push(timeKey);
    }
  }

  if (entry.role === "toolResult" && typeof entry.toolCallId === "string" && entry.toolCallId.length > 0) {
    keys.push(`toolResult:${entry.toolCallId}`);
  }

  if (entry.role === "assistant") {
    if (Array.isArray(entry.content)) {
      for (const block of entry.content) {
        if (block?.type === "toolCall" && typeof block.id === "string" && block.id.length > 0) {
          keys.push(`toolCall:${block.id}`);
        }
      }
    }
    if (index > 0) {
      // Skip mid-conversation system patch messages when resolving the preceding entry for assistantAfter (D-04)
      let prevIdx = index - 1;
      while (prevIdx >= 0 && branch[prevIdx].role === "system") {
        prevIdx--;
      }
      if (prevIdx >= 0) {
        const prev = branch[prevIdx];
        const prevPrimary = getEntryPrimaryKey(prev, prevIdx + 1);
        keys.push(`assistantAfter:${prevPrimary}`);
        if (typeof prev.timestamp === "number" && prev.timestamp > 0) {
          const prevTimeKey = `assistantAfter:${prev.role ?? "unknown"}:${prev.timestamp}`;
          if (!keys.includes(prevTimeKey)) {
            keys.push(prevTimeKey);
          }
        }
        if (prev?.role === "toolResult" && typeof prev.toolCallId === "string" && prev.toolCallId.length > 0) {
          keys.push(`assistantAfter:toolResult:${prev.toolCallId}`);
        }
      }
    }
  }

  return keys;
}

function isPlannerResponseStep(step: any): boolean {
  return (
    step?.type === 15 ||
    step?.type === "CORTEX_STEP_TYPE_PLANNER_RESPONSE" ||
    step?.type === "plannerResponse" ||
    step?.step?.case === "plannerResponse"
  );
}

function isToolExecutionStep(step: any): boolean {
  return (
    step?.type === 132 ||
    step?.type === "CORTEX_STEP_TYPE_MCP_TOOL" ||
    step?.type === "generic" ||
    step?.step?.case === "generic"
  );
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
  async ensureTurnCascade(ctx: TurnContext): Promise<TurnCascade> {
    const { sessionId, branch, modelId, modelName, systemPrompt } = ctx;
    const client = await this.lsConnection.ensureClient();
    let binding = this.bindingStore.get(sessionId);

    const leafEntry = branch.length > 0 ? branch[branch.length - 1] : undefined;
    // pi runtime messages do not always carry an `id`; fall back to a positional key so
    // rewind detection and turn-end recording stay consistent with provider-stream.
    const currentLeafId = leafEntry
      ? (leafEntry.id ?? `${leafEntry.role ?? "unknown"}:${leafEntry.timestamp ?? 0}:${branch.length}`)
      : "";

    // 0. An external provider switch invalidates the existing trajectory: the turns that
    // happened on the other provider never reached this Cascade, so its memory is
    // unrecoverably incomplete. Drop it and replay the full branch into a new Cascade.
    if (ctx.isExternalSwitch) {
      if (this.verbose) {
        console.error(
          `[CascadeManager] External provider switch detected for session ${sessionId}; restarting cascade with ${ctx.priorHistory?.length ?? 0} chars of prior history.`
        );
      }
      this.disposeCascade(sessionId);
      this.bindingStore.remove(sessionId);
      binding = undefined;
    }

    // 1. Prefer existing in-memory Cascade instance for this session (avoid repeat id subscriptions)
    let cascade: Cascade | null = this.activeCascades.get(sessionId) || null;

    // 2. If not in memory (e.g. fresh pi restart), resume from stored binding
    if (!cascade && binding?.cascadeId) {
      try {
        cascade = await client.resumeCascade(binding.cascadeId);
        this.seedResumedCascade(cascade);
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
      // Propagate recorded step indices across all alias keys of each branch entry so
      // toolResult:<callId> and assistantAfter:<parentKey> entries also bind to entry IDs.
      let stepsPropagated = false;
      for (let i = 0; i < branch.length; i++) {
        const keys = getBranchEntryKeys(branch, i);
        let matchedStep: number | undefined;
        for (const k of keys) {
          if (typeof binding.steps[k] === "number") {
            matchedStep = binding.steps[k];
            break;
          }
        }
        if (matchedStep !== undefined) {
          for (const k of keys) {
            if (binding.steps[k] !== matchedStep) {
              binding.steps[k] = matchedStep;
              stepsPropagated = true;
            }
          }
        }
      }

      // Check for history rewind or divergence:
      // If the previous turn's leaf still exists anywhere in the current branch, we are continuing normally.
      // If it does NOT exist, the branch was rewound / forked to a past point (including mid-tool-loop turns)!
      const branchEntryKeys = new Set(branch.flatMap((_, i) => getBranchEntryKeys(branch, i)));
      const isRewound = Boolean(binding.lastLeafId && !branchEntryKeys.has(binding.lastLeafId));

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
          const keys = getBranchEntryKeys(branch, i);
          for (const key of keys) {
            if (typeof binding.steps[key] === "number") {
              targetEntryId = keys[0];
              targetStepIndex = binding.steps[key];
              break;
            }
          }
          if (targetEntryId !== null) {
            break;
          }
        }

        if (targetEntryId !== null && targetStepIndex !== null && targetStepIndex >= 0) {
          if (this.verbose) {
            console.error(
              `[CascadeManager] Reverting cascade ${binding.cascadeId} to stepIndex ${targetStepIndex} (entry ${targetEntryId})`
            );
          }

          let revertSucceeded = false;
          try {
            await client.lsClient.revertToCascadeStep({
              metadata: {
                apiKey: (client as any).apiKey || "",
                ideName: "vscode",
                ideVersion: "1.107.0",
                extensionName: "antigravity",
                extensionVersion: "0.2.0",
              },
              cascadeId: binding.cascadeId,
              stepIndex: targetStepIndex,
              overrideConfig: buildCascadeConfig({
                modelId,
                modelName,
                systemPrompt,
                mcpServerName: ctx.mcpServerName,
                // The trajectory is rolled back in place, so the history the Cascade
                // owns up to the revert point stays valid; only re-assert what it
                // never saw at all.
                conversationHistory: binding.priorHistory,
              }),
            });
            revertSucceeded = true;
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            if (errMsg.includes("step_index out of bounds")) {
              // The Language Server trajectory is already at targetStepIndex (no subsequent
              // steps exist on the server to truncate, e.g. when a turn was aborted right after
              // this step). Treat as already synchronized.
              revertSucceeded = true;
            } else {
              console.error(`[CascadeManager] Failed to revert cascade: ${errMsg}. Starting fresh.`);
              this.disposeCascade(sessionId);
              cascade = null;
            }
          }

          if (revertSucceeded && cascade) {
            // Clean up steps after targetEntryId
            const validEntryIds = new Set(
              branch.flatMap((_, i) => getBranchEntryKeys(branch, i))
            );
            const newSteps: Record<string, number> = {};
            for (const [eid, sidx] of Object.entries(binding.steps)) {
              if (validEntryIds.has(eid) && sidx <= targetStepIndex) {
                newSteps[eid] = sidx;
              }
            }
            newSteps[targetEntryId] = targetStepIndex;

            binding.lastLeafId = targetEntryId;
            binding.steps = newSteps;
            this.bindingStore.set(sessionId, binding);

            // Purge client-side CascadeEventParser cache (lastEmittedText, _lastStepCount)
            // by disposing the stale Cascade instance and resuming a fresh one from the
            // rolled-back trajectory. This prevents past text lengths from swallowing new text deltas. (D-02)
            this.disposeCascade(sessionId);
            try {
              cascade = await client.resumeCascade(binding.cascadeId);
              this.seedResumedCascade(cascade);
              this.attachListeners(cascade);
              this.activeCascades.set(sessionId, cascade);
            } catch (resumeErr: any) {
              if (this.verbose) {
                console.error(`[CascadeManager] Failed to resume cascade after revert: ${resumeErr.message}`);
              }
              cascade = null;
            }
          }
        } else {
          // No common ancestor found in this cascade; start a new cascade
          this.disposeCascade(sessionId);
          cascade = null;
        }
      } else if (stepsPropagated) {
        // Persist propagated alias step keys for normal continuation (D-03)
        this.bindingStore.set(sessionId, binding);
      }
    }

    if (!cascade) {
      this.disposeCascade(sessionId);

      if (this.verbose) {
        console.error(`[CascadeManager] Starting fresh cascade for session ${sessionId}`);
      }
      cascade = await client.startCascade();

      // A brand new Cascade has an empty trajectory, so everything that happened
      // before this turn has to be carried in the prompt.
      const priorHistory = ctx.priorHistory ?? "";

      this.bindingStore.set(sessionId, {
        cascadeId: cascade.cascadeId,
        lastLeafId: currentLeafId,
        steps: {},
        priorHistory,
      });

      this.attachListeners(cascade);
      this.activeCascades.set(sessionId, cascade);

      return { cascade, priorHistory };
    }

    // Reusing a Cascade: its own trajectory already holds every turn it produced, so
    // only the history it never saw (captured when it was created) is re-asserted.
    return { cascade, priorHistory: binding?.priorHistory ?? "" };
  }

  /**
   * Seeds the resumed Cascade's internal event parser with its existing trajectory
   * and IDLE status BEFORE any stream listeners are attached. (D-02)
   */
  private seedResumedCascade(cascade: Cascade): void {
    const raw = cascade as any;
    if (raw?.state) {
      if (!raw.state.status) {
        raw.state.status = 1; // CascadeRunStatus.IDLE
      }
      raw.eventParser?.parseState?.(raw.state);
    }
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
   * Records intermediate step indices when the model parks a tool call mid-turn.
   * Maps both the assistant toolCall message (to its PLANNER_RESPONSE step) and
   * the upcoming toolResult message (to its MCP tool execution step) so `/tree`
   * navigation can rewind to any intermediate point inside a multi-tool loop.
   */
  async recordToolCallStep(
    sessionId: string,
    branch: Array<{ id?: string; role?: string; timestamp?: number; content?: any; toolCallId?: string; [key: string]: any }>,
    assistantMessage: { id?: string; role?: string; timestamp?: number; content?: any; [key: string]: any },
    callId: string,
    cascade: Cascade
  ): Promise<void> {
    const binding = this.bindingStore.get(sessionId);
    if (!binding) return;

    try {
      const hist = await cascade.getHistory();
      const steps = (hist.trajectory?.steps || []) as any[];

      const hasTypedSteps = steps.some((s) => isPlannerResponseStep(s) || isToolExecutionStep(s));
      let assistantStepIdx = 0;
      let toolResultStepIdx = 0;

      if (hasTypedSteps) {
        let lastPlanner = -1;
        for (let i = steps.length - 1; i >= 0; i--) {
          if (isPlannerResponseStep(steps[i])) {
            lastPlanner = i;
            break;
          }
        }
        assistantStepIdx = lastPlanner >= 0 ? lastPlanner : Math.max(0, steps.length - 2);

        let lastGenericAfterPlanner = -1;
        for (let i = steps.length - 1; i > assistantStepIdx; i--) {
          if (isToolExecutionStep(steps[i])) {
            lastGenericAfterPlanner = i;
            break;
          }
        }
        toolResultStepIdx =
          lastGenericAfterPlanner >= 0 ? lastGenericAfterPlanner : assistantStepIdx + 1;
      } else if (steps.length >= 2) {
        assistantStepIdx = steps.length - 2;
        toolResultStepIdx = steps.length - 1;
      } else if (steps.length === 1) {
        assistantStepIdx = 0;
        toolResultStepIdx = 1;
      }

      // Propagate any already-known step indices on existing branch entries
      for (let i = 0; i < branch.length; i++) {
        const keys = getBranchEntryKeys(branch, i);
        const existing = keys.map((k) => binding.steps[k]).find((v) => typeof v === "number");
        if (existing !== undefined) {
          for (const k of keys) {
            binding.steps[k] = existing;
          }
        }
      }

      // Record the assistant (toolUse) message step index
      const extendedBranch = [...branch, assistantMessage];
      const asstKeys = getBranchEntryKeys(extendedBranch, branch.length);
      for (const k of asstKeys) {
        binding.steps[k] = assistantStepIdx;
      }

      // Record the upcoming toolResult step index keyed by its immutable toolCallId
      const toolResultKey = `toolResult:${callId}`;
      binding.steps[toolResultKey] = toolResultStepIdx;
      binding.lastLeafId = toolResultKey;

      this.bindingStore.set(sessionId, binding);

      if (this.verbose) {
        console.error(
          `[CascadeManager] Recorded tool call step: session=${sessionId}, callId=${callId}, assistantStep=${assistantStepIdx}, toolResultStep=${toolResultStepIdx}`
        );
      }
    } catch (e: any) {
      if (this.verbose) {
        console.error(`[CascadeManager] Failed to record tool call step: ${e.message}`);
      }
    }
  }

  /**
   * Records the completion of a turn, mapping the new leaf entry ID to the 0-based final step index. (D-01)
   */
  async recordTurnEnd(
    sessionId: string,
    newLeafId: string,
    cascade: Cascade,
    options?: RecordTurnEndOptions
  ): Promise<void> {
    const binding = this.bindingStore.get(sessionId);
    if (!binding) return;

    try {
      const hist = await cascade.getHistory();
      const steps = hist.trajectory?.steps || [];
      // Record 0-based index of the final step in the trajectory.
      // revertToCascadeStep({ stepIndex }) retains steps up to and including stepIndex.
      // Using stepCount - 1 ensures we roll back to the end of this turn rather than
      // retaining the user input of the subsequent turn (off-by-one fix D-01).
      const lastIndex = steps.length > 0 ? steps.length - 1 : 0;

      if (options?.branch && options?.assistantMessage) {
        const { branch, assistantMessage } = options;

        // Propagate known step indices on existing branch entries (e.g. toolResult:<callId> -> entry key)
        for (let i = 0; i < branch.length; i++) {
          const keys = getBranchEntryKeys(branch, i);
          const existing = keys.map((k) => binding.steps[k]).find((v) => typeof v === "number");
          if (existing !== undefined) {
            for (const k of keys) {
              binding.steps[k] = existing;
            }
          }
        }

        const lastBranchEntry = branch.length > 0 ? branch[branch.length - 1] : undefined;
        // When the turn had no intermediate tool calls (lastBranchEntry is user), also record
        // on newLeafId so direct user-entry lookups remain compatible. When lastBranchEntry is
        // a toolResult, preserve its own tool execution step index rather than overwriting it
        // with the final assistant response step index.
        if (lastBranchEntry?.role !== "toolResult") {
          binding.steps[newLeafId] = lastIndex;
        }

        const extendedBranch = [...branch, assistantMessage];
        const asstKeys = getBranchEntryKeys(extendedBranch, branch.length);
        for (const k of asstKeys) {
          binding.steps[k] = lastIndex;
        }

        const afterKey = asstKeys.find((k) => k.startsWith("assistantAfter:"));
        binding.lastLeafId = afterKey ?? asstKeys[0] ?? newLeafId;
      } else {
        binding.lastLeafId = newLeafId;
        binding.steps[newLeafId] = lastIndex;
      }

      this.bindingStore.set(sessionId, binding);

      if (this.verbose) {
        console.error(
          `[CascadeManager] Recorded turn end: session=${sessionId}, leafId=${binding.lastLeafId}, lastIndex=${lastIndex}`
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

  /**
   * Disposes all active in-memory Cascade stream subscriptions without clearing
   * persisted session bindings on disk. Called on session_shutdown / process exit. (D-01)
   */
  disposeAll(): void {
    for (const [sessionId] of this.activeCascades) {
      this.disposeCascade(sessionId);
    }
  }

  clearSession(sessionId: string): void {
    this.bindingStore.remove(sessionId);
    this.disposeCascade(sessionId);
  }

  clearAll(): void {
    this.bindingStore.clear();
    this.disposeAll();
  }
}
