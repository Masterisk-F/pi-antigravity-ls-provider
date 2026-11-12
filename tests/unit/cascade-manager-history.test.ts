import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";

/**
 * Minimal stand-in for an Antigravity `Cascade`: only the surface CascadeManager touches.
 */
class FakeCascade extends EventEmitter {
  readonly cascadeId: string;
  disposed = false;
  cancelled = false;
  stepCount = 0;
  state: any = { status: 0, trajectory: { steps: [] } };
  eventParser: any;

  constructor(cascadeId: string) {
    super();
    this.cascadeId = cascadeId;
    this.eventParser = {
      parsedState: null,
      parseState: (s: any) => {
        this.eventParser.parsedState = s;
      },
    };
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

function createFakeClient(): { client: FakeClient; started: FakeCascade[]; resumed: FakeCascade[]; reverts: any[] } {
  const started: FakeCascade[] = [];
  const resumed: FakeCascade[] = [];
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
      resumed.push(cascade);
      return cascade;
    },
    lsClient: {
      async revertToCascadeStep(args: any) {
        reverts.push(args);
        return {};
      },
    },
  };

  return { client, started, resumed, reverts };
}

function createBindingStore(): BindingStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-history-"));
  return new BindingStore(dir);
}

function ctx(overrides: Record<string, any> = {}) {
  return {
    sessionId: "sess-1",
    branch: [
      { id: "e1", role: "user" },
      { id: "e2", role: "assistant", provider: "antigravity-ls" },
      { id: "e3", role: "user" },
    ],
    modelId: 1319,
    modelName: "Gemini 3.8 Flash (Medium)",
    systemPrompt: "pi system prompt",
    mcpServerName: "pi-tools-1",
    ...overrides,
  };
}

describe("CascadeManager prior-history handling (Integration)", () => {
  it("restarts the Cascade when the previous assistant turn came from another provider", async () => {
    const { client, started } = createFakeClient();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, createBindingStore());

    const first = await manager.ensureTurnCascade(ctx());
    assert.strictEqual(first.cascade.cascadeId, "cascade-1");
    assert.strictEqual(first.priorHistory, "");

    // A turn produced on Claude: the new Cascade must replace the old trajectory.
    const switched = await manager.ensureTurnCascade(
      ctx({
        isExternalSwitch: true,
        priorHistory: "[User]: codename is ZETA-9",
      })
    );

    assert.strictEqual(switched.cascade.cascadeId, "cascade-2");
    assert.strictEqual(switched.priorHistory, "[User]: codename is ZETA-9");
    assert.strictEqual(started[0].disposed, true, "previous cascade must be disposed");
    assert.strictEqual(started[1].disposed, false);
  });

  it("keeps the same Cascade and its history when the provider did not switch", async () => {
    const { client, started } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    const first = await manager.ensureTurnCascade(ctx({ priorHistory: "[User]: earlier turn" }));
    assert.strictEqual(first.priorHistory, "[User]: earlier turn");

    // Record a turn end so the binding's lastLeafId is in the branch.
    await manager.recordTurnEnd("sess-1", "e3", first.cascade as any);

    const second = await manager.ensureTurnCascade(
      ctx({
        branch: [
          { id: "e1", role: "user" },
          { id: "e2", role: "assistant", provider: "antigravity-ls" },
          { id: "e3", role: "user" },
          { id: "e4", role: "assistant", provider: "antigravity-ls" },
          { id: "e5", role: "user" },
        ],
      })
    );

    assert.strictEqual(second.cascade.cascadeId, first.cascade.cascadeId, "cascade must be reused");
    assert.strictEqual(started.length, 1, "no new cascade must be started");
    // The Cascade's own trajectory already covers later turns; only the prefix persists.
    assert.strictEqual(second.priorHistory, "[User]: earlier turn");
  });

  it("persists priorHistory across a rewind and passes it to revertToCascadeStep", async () => {
    const { client, reverts } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    const first = await manager.ensureTurnCascade(ctx({ priorHistory: "[User]: prefix turn" }));
    (first.cascade as unknown as FakeCascade).stepCount = 4;
    await manager.recordTurnEnd("sess-1", "e3", first.cascade as any);

    // Rewind to a branch that no longer contains e3, but does contain a recorded ancestor.
    const binding = store.get("sess-1")!;
    binding.steps["e1"] = 1;
    store.set("sess-1", binding);

    const rewound = await manager.ensureTurnCascade(
      ctx({
        branch: [
          { id: "e1", role: "user" },
          { id: "e9", role: "user" },
        ],
        priorHistory: "[User]: prefix turn",
      })
    );

    assert.strictEqual(reverts.length, 1, "revertToCascadeStep must be called once");
    assert.strictEqual(reverts[0].stepIndex, 1);
    const sections = reverts[0].overrideConfig.plannerConfig.plannerTypeConfig.value.promptSections;
    const historySection = sections.find((s: any) => s.item.value.title === "conversation_history");
    assert.ok(historySection, "revert must carry the prior history");
    assert.ok(historySection.item.value.content.includes("prefix turn"));
    assert.strictEqual(rewound.cascade.cascadeId, first.cascade.cascadeId);
    assert.strictEqual(rewound.priorHistory, "[User]: prefix turn");
  });

  it("falls back to positional keys so id-less runtime messages still record turn ends", async () => {
    const { client } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    const turn = await manager.ensureTurnCascade(
      ctx({ branch: [{ role: "user", timestamp: 1000 }] })
    );
    await manager.recordTurnEnd("sess-1", "user:1000:1", turn.cascade as any);

    const binding = store.get("sess-1")!;
    assert.strictEqual(binding.steps["user:1000:1"], 0);
    assert.strictEqual(binding.lastLeafId, "user:1000:1");
  });

  it("disposeAll disposes active cascades while preserving session bindings on disk (D-01)", async () => {
    const { client } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    const turn = await manager.ensureTurnCascade(ctx());
    (turn.cascade as unknown as FakeCascade).stepCount = 2;
    await manager.recordTurnEnd("sess-1", "e3", turn.cascade as any);

    const activeCascade = turn.cascade as unknown as FakeCascade;
    assert.strictEqual(activeCascade.disposed, false);

    // Call disposeAll (simulating session_shutdown / process exit)
    manager.disposeAll();

    assert.strictEqual(activeCascade.disposed, true, "Active cascade must be disposed");
    assert.strictEqual(manager.getActiveCascade("sess-1"), undefined, "In-memory reference must be cleared");

    // Disk binding must still exist intact!
    const binding = store.get("sess-1");
    assert.ok(binding, "Binding must be preserved on disk after disposeAll");
    assert.strictEqual(binding.cascadeId, activeCascade.cascadeId);
    assert.strictEqual(binding.steps["e3"], 1);
  });

  it("resumes cascade from disk binding in fresh manager and seeds event parser (D-02)", async () => {
    const { client, resumed } = createFakeClient();
    const store = createBindingStore();

    // 1. First process: start cascade and record turn end
    const manager1 = new CascadeManager({ ensureClient: async () => client } as any, store);
    const turn1 = await manager1.ensureTurnCascade(ctx());
    const initialCascadeId = turn1.cascade.cascadeId;
    (turn1.cascade as unknown as FakeCascade).stepCount = 2;
    await manager1.recordTurnEnd("sess-1", "e3", turn1.cascade as any);
    manager1.disposeAll();

    // 2. Second process (fresh CascadeManager instance using same store)
    const manager2 = new CascadeManager({ ensureClient: async () => client } as any, store);
    const turn2 = await manager2.ensureTurnCascade(
      ctx({
        branch: [
          { id: "e1", role: "user" },
          { id: "e2", role: "assistant", provider: "antigravity-ls" },
          { id: "e3", role: "user" },
          { id: "e4", role: "assistant", provider: "antigravity-ls" },
          { id: "e5", role: "user" },
        ],
      })
    );

    assert.strictEqual(turn2.cascade.cascadeId, initialCascadeId, "Must resume same cascadeId from disk");
    assert.strictEqual(resumed.length, 1, "Must invoke client.resumeCascade");

    const resumedCascade = turn2.cascade as unknown as FakeCascade;
    // D-02: seedResumedCascade must set status = 1 (IDLE) and invoke eventParser.parseState
    assert.strictEqual(resumedCascade.state.status, 1, "Status must be seeded to IDLE (1)");
    assert.ok(resumedCascade.eventParser.parsedState, "eventParser.parseState must be called during resume");
  });

  it("falls back to fresh cascade if client.resumeCascade throws (e.g. expired on LS)", async () => {
    const store = createBindingStore();
    store.set("sess-1", {
      cascadeId: "expired-cascade-id",
      lastLeafId: "e3",
      steps: { e3: 1 },
      priorHistory: "[User]: old history",
    });

    let startCalled = false;
    const client: FakeClient = {
      async startCascade() {
        startCalled = true;
        return new FakeCascade("fresh-cascade-new");
      },
      async resumeCascade() {
        throw new Error("Cascade expired or not found on LS");
      },
      lsClient: {
        async revertToCascadeStep() { return {}; },
      },
    };

    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);
    const turn = await manager.ensureTurnCascade(ctx({ priorHistory: "[User]: new history" }));

    assert.strictEqual(startCalled, true, "Must start fresh cascade on resume failure");
    assert.strictEqual(turn.cascade.cascadeId, "fresh-cascade-new");
  });

  it("handles mid-conversation system patches without breaking branch continuation (D-04)", async () => {
    const { client } = createFakeClient();
    const store = createBindingStore();
    const manager = new CascadeManager({ ensureClient: async () => client } as any, store);

    // Turn 1
    const u1 = { role: "user", content: "hello", timestamp: 1000 };
    const a1 = { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2000, provider: "antigravity-ls" };
    const turn1 = await manager.ensureTurnCascade({
      sessionId: "sess-sys",
      branch: [u1],
      modelId: 1319,
      systemPrompt: "prompt",
    });
    (turn1.cascade as unknown as FakeCascade).stepCount = 2;
    await manager.recordTurnEnd("sess-sys", "user:1000:1", turn1.cascade as any, {
      branch: [u1],
      assistantMessage: a1,
    });

    const binding1 = store.get("sess-sys")!;
    assert.ok(binding1.steps["assistantAfter:user:1000"] !== undefined || binding1.steps["assistantAfter:user:1000:1"] !== undefined);

    // Turn 2: Pi resumes session and inserts a diff system message right before the new user prompt
    const sysPatch = { role: "system", content: "", sections: { rules: "new rule" }, timestamp: 2500 };
    const u2 = { role: "user", content: "continue", timestamp: 3000 };

    const turn2 = await manager.ensureTurnCascade({
      sessionId: "sess-sys",
      branch: [u1, a1, sysPatch, u2],
      modelId: 1319,
      systemPrompt: "prompt updated",
    });

    // Continuation must be normal (same cascade, not rewound or reset)
    assert.strictEqual(turn2.cascade.cascadeId, turn1.cascade.cascadeId, "Same cascade must continue despite system patch");
  });
});
