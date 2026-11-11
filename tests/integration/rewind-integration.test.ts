import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

class MockCascade extends EventEmitter {
  constructor(public readonly cascadeId: string) {
    super();
  }
  steps: Array<{ type: number }> = [];

  async getHistory() {
    return {
      trajectory: {
        steps: this.steps,
      },
    };
  }

  async cancel() {}
  dispose() {}
}

describe("Rewind Full Flow Integration", () => {
  it("executes Turn 1 -> Turn 2 -> Rewind to Turn 1 -> Turn 3 with accurate step rollback", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-full-rewind-"));
    const store = new BindingStore(path.join(tmpDir, "bindings.json"));

    const cascade = new MockCascade("casc-flow-1");
    const revertCalls: any[] = [];

    const mockClient = {
      startCascade: async () => cascade,
      resumeCascade: async (id: string) => cascade,
      lsClient: {
        revertToCascadeStep: async (args: any) => {
          revertCalls.push(args);
          // Simulate LS truncating trajectory to stepIndex
          cascade.steps = cascade.steps.slice(0, args.stepIndex + 1);
          return { metadata: {} };
        },
      },
    };

    const manager = new CascadeManager({ ensureClient: async () => mockClient } as any, store);

    // ── Turn 1 ──
    const turn1Branch = [{ id: "msg-user-1", role: "user" }];
    const turn1 = await manager.ensureTurnCascade({
      sessionId: "session-flow",
      branch: turn1Branch,
      modelId: 1319,
      systemPrompt: "prompt",
    });

    // LS generates step 0 (USER_INPUT) and step 1 (PLANNER_RESPONSE)
    cascade.steps = [{ type: 14 }, { type: 15 }];
    await manager.recordTurnEnd("session-flow", "msg-user-1", turn1.cascade as any);

    // Binding check: index 1 stored
    let binding = store.get("session-flow")!;
    assert.strictEqual(binding.steps["msg-user-1"], 1);

    // ── Turn 2 ──
    const turn2Branch = [
      { id: "msg-user-1", role: "user" },
      { id: "msg-asst-1", role: "assistant", provider: "antigravity-ls" },
      { id: "msg-user-2", role: "user" },
    ];
    const turn2 = await manager.ensureTurnCascade({
      sessionId: "session-flow",
      branch: turn2Branch,
      modelId: 1319,
      systemPrompt: "prompt",
    });

    // LS appends step 2 (USER_INPUT) and step 3 (PLANNER_RESPONSE)
    cascade.steps = [{ type: 14 }, { type: 15 }, { type: 14 }, { type: 15 }];
    await manager.recordTurnEnd("session-flow", "msg-user-2", turn2.cascade as any);

    binding = store.get("session-flow")!;
    assert.strictEqual(binding.steps["msg-user-2"], 3);

    // ── Rewind to Turn 1 ──
    // In Pi, rewind to Turn 1 produces a branch ending at Turn 1's assistant,
    // followed by a new user message for Turn 3 ("What was my last message?")
    const rewoundBranch = [
      { id: "msg-user-1", role: "user" },
      { id: "msg-asst-1", role: "assistant", provider: "antigravity-ls" },
      { id: "msg-user-3", role: "user" }, // New turn
    ];

    const turn3 = await manager.ensureTurnCascade({
      sessionId: "session-flow",
      branch: rewoundBranch,
      modelId: 1319,
      systemPrompt: "prompt",
    });

    // Verify revert was called
    assert.strictEqual(revertCalls.length, 1);
    // Crucial check: revertToCascadeStep must be called with stepIndex: 1 (Turn 1 response),
    // NOT stepIndex: 2 (which would have preserved Turn 2's user input!)
    assert.strictEqual(revertCalls[0].stepIndex, 1, "Must revert to Step 1 (Turn 1 response)");
    assert.strictEqual(revertCalls[0].cascadeId, "casc-flow-1");

    // Trajectory in LS is now cleanly rolled back to 2 steps (Step 0 and Step 1)
    assert.strictEqual(cascade.steps.length, 2, "Trajectory must contain only Step 0 and Step 1");

    // Binding must be updated: msg-user-2 is pruned
    binding = store.get("session-flow")!;
    assert.strictEqual(binding.lastLeafId, "msg-user-1");
    assert.strictEqual(binding.steps["msg-user-2"], undefined);
    assert.strictEqual(binding.steps["msg-user-1"], 1);
  });
});
