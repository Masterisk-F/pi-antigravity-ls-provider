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

  it("handles multi-tool turn -> /tree navigation to intermediate TR1 -> rolls back to TR1 step index cleanly (Section 6.2b)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-multitool-rewind-"));
    const store = new BindingStore(path.join(tmpDir, "bindings.json"));

    const cascade = new MockCascade("casc-flow-2");
    const revertCalls: any[] = [];

    const mockClient = {
      startCascade: async () => cascade,
      resumeCascade: async (id: string) => cascade,
      lsClient: {
        revertToCascadeStep: async (args: any) => {
          revertCalls.push(args);
          cascade.steps = cascade.steps.slice(0, args.stepIndex + 1);
          return { metadata: {} };
        },
      },
    };

    const manager = new CascadeManager({ ensureClient: async () => mockClient } as any, store);

    // Initial branch with user prompt U1
    const u1 = { id: "msg-u1", role: "user" };
    const turn1 = await manager.ensureTurnCascade({
      sessionId: "session-multi",
      branch: [u1],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    // 1. Model parks first tool call (A1): step 0 (userInput), step 1 (plannerResponse), step 2 (generic)
    cascade.steps = [
      { type: 14 },
      { type: 15, step: { case: "plannerResponse", value: { toolCalls: [{ id: "call_1", name: "read" }] } } } as any,
      { type: 132, step: { case: "generic", value: {} } } as any,
    ];
    const a1 = {
      id: "msg-a1",
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
    };
    await manager.recordToolCallStep("session-multi", [u1], a1, "call_1", turn1.cascade as any);

    // Pi executes tool 1 -> TR1
    const tr1 = {
      id: "msg-tr1",
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "secret_a" }],
    };

    // 2. Model parks second tool call (A2): step 3 (plannerResponse), step 4 (generic)
    cascade.steps = [
      ...cascade.steps,
      { type: 15, step: { case: "plannerResponse", value: { toolCalls: [{ id: "call_2", name: "read" }] } } } as any,
      { type: 132, step: { case: "generic", value: {} } } as any,
    ];
    const a2 = {
      id: "msg-a2",
      role: "assistant",
      content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.txt" } }],
    };
    await manager.recordToolCallStep("session-multi", [u1, a1, tr1], a2, "call_2", turn1.cascade as any);

    // Pi executes tool 2 -> TR2
    const tr2 = {
      id: "msg-tr2",
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "read",
      content: [{ type: "text", text: "secret_b" }],
    };

    // 3. Model finishes with final text A3: step 5 (plannerResponse)
    cascade.steps = [
      ...cascade.steps,
      { type: 15, step: { case: "plannerResponse", value: { response: "Done." } } } as any,
    ];
    const a3 = {
      id: "msg-a3",
      role: "assistant",
      content: [{ type: "text", text: "Done." }],
    };
    await manager.recordTurnEnd("session-multi", "msg-a3", turn1.cascade as any, {
      branch: [u1, a1, tr1, a2, tr2],
      assistantMessage: a3,
    });

    // ── Simulate user navigating with /tree to TR1 (after tool 1) and typing new prompt U_new ──
    const rewoundBranch = [
      u1,
      a1,
      tr1,
      { id: "msg-unew", role: "user" },
    ];

    const turn2 = await manager.ensureTurnCascade({
      sessionId: "session-multi",
      branch: rewoundBranch,
      modelId: 1319,
      systemPrompt: "prompt",
    });

    assert.strictEqual(revertCalls.length, 1, "revertToCascadeStep must be called");
    assert.strictEqual(
      revertCalls[0].stepIndex,
      2,
      "revert stepIndex must be 2 (the generic step of toolResult TR1)"
    );
    assert.strictEqual(cascade.steps.length, 3, "Trajectory in LS must be truncated to steps 0, 1, 2");

    const binding = store.get("session-multi")!;
    assert.strictEqual(binding.lastLeafId, "msg-tr1");
    assert.strictEqual(binding.steps["toolResult:call_1"], 2);
    assert.strictEqual(binding.steps["toolResult:call_2"], undefined, "TR2 must be pruned");
    assert.strictEqual(binding.steps["msg-a3"], undefined, "A3 must be pruned");
  });
});
