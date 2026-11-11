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
});
