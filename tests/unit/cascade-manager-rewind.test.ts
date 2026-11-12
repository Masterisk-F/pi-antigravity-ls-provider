import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";

class FakeCascade extends EventEmitter {
  readonly cascadeId: string;
  disposed = false;
  cancelled = false;
  stepCount = 0;

  constructor(cascadeId: string) {
    super();
    this.cascadeId = cascadeId;
  }

  dispose(): void {
    this.disposed = true;
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }

  async getHistory(): Promise<{ trajectory: { steps: unknown[] } }> {
    return { trajectory: { steps: new Array(this.stepCount).fill({}) } };
  }
}

interface FakeClient {
  startCascade(): Promise<FakeCascade>;
  resumeCascade(cascadeId: string): Promise<FakeCascade>;
  lsClient: {
    revertToCascadeStep(args: any): Promise<unknown>;
  };
}

function createFakeClient(): { client: FakeClient; started: FakeCascade[]; reverts: any[] } {
  const started: FakeCascade[] = [];
  const reverts: any[] = [];
  let seq = 0;

  const client: FakeClient = {
    async startCascade() {
      const cascade = new FakeCascade(`cascade-${++seq}`);
      started.push(cascade);
      return cascade;
    },
    async resumeCascade(cascadeId: string) {
      const cascade = new FakeCascade(cascadeId);
      started.push(cascade);
      return cascade;
    },
    lsClient: {
      async revertToCascadeStep(args: any) {
        reverts.push(args);
        return {};
      },
    },
  };

  return { client, started, reverts };
}

function createBindingStore(): BindingStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-rewind-test-"));
  return new BindingStore(path.join(dir, "bindings.json"));
}

describe("CascadeManager Rewind Accuracy (Unit - D-01)", () => {
  it("records 0-based final step index on turn end to prevent off-by-one retention of subsequent turns", async () => {
    const { client } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Initial Turn 1: 2 steps generated (Step 0: USER_INPUT, Step 1: PLANNER_RESPONSE)
    const turn1 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [{ id: "e1", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    (turn1.cascade as unknown as FakeCascade).stepCount = 2;
    await manager.recordTurnEnd("s1", "e1", turn1.cascade as any);

    const binding1 = store.get("s1")!;
    // D-01: stepCount 2 should be stored as 0-based final index 1 (Step 1)
    assert.strictEqual(binding1.steps["e1"], 1, "Turn 1 step index must be stepCount - 1 (1)");
    assert.strictEqual(binding1.lastLeafId, "e1");

    // Turn 2: 4 steps total (Step 2: USER_INPUT, Step 3: PLANNER_RESPONSE)
    const turn2 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [
        { id: "e1", role: "user" },
        { id: "e2", role: "assistant" },
        { id: "e3", role: "user" },
      ],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    (turn2.cascade as unknown as FakeCascade).stepCount = 4;
    await manager.recordTurnEnd("s1", "e3", turn2.cascade as any);

    const binding2 = store.get("s1")!;
    // D-01: stepCount 4 should be stored as 0-based final index 3 (Step 3)
    assert.strictEqual(binding2.steps["e3"], 3, "Turn 2 step index must be stepCount - 1 (3)");
    assert.strictEqual(binding2.lastLeafId, "e3");
  });

  it("reverts accurately to Step 1 without retaining Turn 2's user input when rewinding to Turn 1", async () => {
    const { client, reverts } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Setup stored binding as if Turn 1 (index 1) and Turn 2 (index 3) were recorded
    store.set("s1", {
      cascadeId: "cascade-1",
      lastLeafId: "e3",
      steps: {
        e1: 1, // End of Turn 1
        e3: 3, // End of Turn 2
      },
    });

    // Rewind: user branches back to after Turn 1 (e3 is gone, e1 is present)
    const rewoundTurn = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [
        { id: "e1", role: "user" },
        { id: "e4", role: "user" }, // New question after rewind
      ],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    assert.strictEqual(reverts.length, 1, "revertToCascadeStep should be called");
    assert.strictEqual(reverts[0].stepIndex, 1, "revert stepIndex must be 1, rolling back Turn 2 completely");
    assert.ok(reverts[0].metadata, "metadata with IDE info must be included in revert request");

    // Cleaned up binding
    const updatedBinding = store.get("s1")!;
    assert.strictEqual(updatedBinding.lastLeafId, "e1");
    assert.strictEqual(updatedBinding.steps["e1"], 1);
    assert.strictEqual(updatedBinding.steps["e3"], undefined, "Turn 2 step must be pruned from binding");
  });

  it("starts a fresh cascade when rewinding to root before any recorded steps", async () => {
    const { client, started } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    store.set("s1", {
      cascadeId: "cascade-old",
      lastLeafId: "e3",
      steps: { e3: 3 },
    });

    // Rewind to an entry with no recorded ancestor
    const rewoundTurn = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [{ id: "brand-new-root", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    assert.notStrictEqual(rewoundTurn.cascade.cascadeId, "cascade-old", "A fresh cascade must be started");
    assert.strictEqual(started[0].disposed, true, "Old cascade must be disposed");
  });

  it("records intermediate toolCall and toolResult steps and accurately rewinds to TR1, A1, A2, and TR2 (D-01, D-02, D-03)", async () => {
    const { client, reverts } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Initial Turn 1: User prompt U1
    const u1 = { id: "u1", role: "user" };
    const turn1 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u1],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    const fakeCascade = turn1.cascade as unknown as FakeCascade;

    // Sub-turn 1: model calls tool 1 (call_1) -> step 1 (plannerResponse), step 2 (generic)
    fakeCascade.stepCount = 3;
    const a1 = {
      id: "a1",
      role: "assistant",
      content: [{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "a.txt" } }],
    };
    await manager.recordToolCallStep("s1", [u1], a1, "call_1", turn1.cascade as any);

    // Pi executes tool 1 -> tr1
    const tr1 = {
      id: "tr1",
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "secret_a" }],
    };

    // Sub-turn 2: model calls tool 2 (call_2) -> step 3 (plannerResponse), step 4 (generic)
    fakeCascade.stepCount = 5;
    const a2 = {
      id: "a2",
      role: "assistant",
      content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: "b.txt" } }],
    };
    await manager.recordToolCallStep("s1", [u1, a1, tr1], a2, "call_2", turn1.cascade as any);

    // Pi executes tool 2 -> tr2
    const tr2 = {
      id: "tr2",
      role: "toolResult",
      toolCallId: "call_2",
      toolName: "read",
      content: [{ type: "text", text: "secret_b" }],
    };

    // Sub-turn 3: model produces final response -> step 5 (plannerResponse)
    fakeCascade.stepCount = 6;
    const a3 = {
      id: "a3",
      role: "assistant",
      content: [{ type: "text", text: "Both secrets reported." }],
    };
    await manager.recordTurnEnd("s1", "a3", turn1.cascade as any, {
      branch: [u1, a1, tr1, a2, tr2],
      assistantMessage: a3,
    });

    // Snapshot deep clone of binding after Turn 1
    const bindingAfterTurn1 = JSON.parse(JSON.stringify(store.get("s1")!));
    assert.strictEqual(bindingAfterTurn1.steps["toolResult:call_1"], 2, "TR1 must be step 2");
    assert.strictEqual(bindingAfterTurn1.steps["toolResult:call_2"], 4, "TR2 must be step 4");
    assert.strictEqual(bindingAfterTurn1.steps["toolCall:call_1"], 1, "A1 toolCall must be step 1");
    assert.strictEqual(bindingAfterTurn1.steps["toolCall:call_2"], 3, "A2 toolCall must be step 3");
    assert.strictEqual(bindingAfterTurn1.steps["a3"], 5, "Final A3 must be step 5");

    // ── Rewind Scenario A: /tree to TR1 (after first tool execution) ──
    reverts.length = 0;
    const rewindTR1 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u1, a1, tr1, { id: "u_new1", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    assert.strictEqual(reverts.length, 1, "revertToCascadeStep must be called");
    assert.strictEqual(reverts[0].stepIndex, 2, "Must revert to Step 2 (TR1 generic step)");
    assert.strictEqual(rewindTR1.cascade.cascadeId, turn1.cascade.cascadeId);

    // Reset store to state after Turn 1 for next scenario
    store.set("s1", JSON.parse(JSON.stringify(bindingAfterTurn1)));

    // ── Rewind Scenario B: /tree to A1 (tool call 1 before TR1) ──
    reverts.length = 0;
    const rewindA1 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u1, a1, { id: "u_new2", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    assert.strictEqual(reverts.length, 1);
    assert.strictEqual(reverts[0].stepIndex, 1, "Must revert to Step 1 (A1 plannerResponse step)");

    // Reset store to state after Turn 1 for next scenario
    store.set("s1", JSON.parse(JSON.stringify(bindingAfterTurn1)));

    // ── Rewind Scenario C: /tree to A2 (tool call 2) ──
    reverts.length = 0;
    const rewindA2 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u1, a1, tr1, a2, { id: "u_new3", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    assert.strictEqual(reverts.length, 1);
    assert.strictEqual(reverts[0].stepIndex, 3, "Must revert to Step 3 (A2 plannerResponse step)");

    // Reset store to state after Turn 1 for next scenario
    store.set("s1", JSON.parse(JSON.stringify(bindingAfterTurn1)));

    // ── Rewind Scenario D: /tree to TR2 (right before final response A3) ──
    reverts.length = 0;
    const rewindTR2 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u1, a1, tr1, a2, tr2, { id: "u_new4", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    assert.strictEqual(reverts.length, 1, "Must detect rewind when A3 is dropped even though TR2 is present");
    assert.strictEqual(reverts[0].stepIndex, 4, "Must revert to Step 4 (TR2 generic step), dropping Step 5");
  });

  it("does not over-rollback to Turn 0 when rewinding to an intermediate tool step in Turn 1", async () => {
    const { client, reverts } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Turn 0: step 0 (user), step 1 (assistant)
    const u0 = { id: "u0", role: "user" };
    const a0 = { id: "a0", role: "assistant", content: [{ type: "text", text: "turn 0 response" }] };
    const turn0 = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u0],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    (turn0.cascade as unknown as FakeCascade).stepCount = 2;
    await manager.recordTurnEnd("s1", "a0", turn0.cascade as any, { branch: [u0], assistantMessage: a0 });

    // Turn 1: step 2 (user), step 3 (plannerResponse call_1), step 4 (generic call_1), step 5 (final plannerResponse)
    const u1 = { id: "u1", role: "user" };
    const a1 = { id: "a1", role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "read", arguments: {} }] };
    const tr1 = { id: "tr1", role: "toolResult", toolCallId: "call_1", content: [{ type: "text", text: "data" }] };
    const a2 = { id: "a2", role: "assistant", content: [{ type: "text", text: "done" }] };

    await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u0, a0, u1],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    (turn0.cascade as unknown as FakeCascade).stepCount = 5;
    await manager.recordToolCallStep("s1", [u0, a0, u1], a1, "call_1", turn0.cascade as any);

    (turn0.cascade as unknown as FakeCascade).stepCount = 6;
    await manager.recordTurnEnd("s1", "a2", turn0.cascade as any, {
      branch: [u0, a0, u1, a1, tr1],
      assistantMessage: a2,
    });

    // Rewind to Turn 1 TR1:
    reverts.length = 0;
    await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [u0, a0, u1, a1, tr1, { id: "u_new", role: "user" }],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    assert.strictEqual(reverts.length, 1);
    assert.strictEqual(
      reverts[0].stepIndex,
      4,
      "Must revert to Step 4 (Turn 1 TR1), NEVER over-rollback to Turn 0 (Step 1)"
    );
  });

  it("handles step_index out of bounds gracefully without discarding the cascade (D-04)", async () => {
    const { client } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Mock revertToCascadeStep throwing step_index out of bounds
    client.lsClient.revertToCascadeStep = async () => {
      throw new Error("ConnectError: [unknown] step_index out of bounds: 2");
    };

    store.set("s1", {
      cascadeId: "cascade-1",
      lastLeafId: "assistantAfter:tr2",
      steps: {
        tr1: 2,
        tr2: 4,
        "assistantAfter:tr2": 5,
      },
    });

    const rewoundTurn = await manager.ensureTurnCascade({
      sessionId: "s1",
      branch: [
        { id: "u1", role: "user" },
        { id: "a1", role: "assistant" },
        { id: "tr1", role: "toolResult" },
        { id: "u_new", role: "user" },
      ],
      modelId: 1319,
      systemPrompt: "prompt",
    });

    assert.strictEqual(
      rewoundTurn.cascade.cascadeId,
      "cascade-1",
      "Cascade must NOT be disposed or restarted when step_index out of bounds occurs"
    );
    const updated = store.get("s1")!;
    assert.strictEqual(updated.lastLeafId, "tr1");
  });
});
