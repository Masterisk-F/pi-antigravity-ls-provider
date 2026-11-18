import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";

describe("CascadeManager Generation & Reconnect History Recovery (Unit)", () => {
  it("purges stale in-memory cascade when LS generation changes (D-02)", async () => {
    let disposed = false;
    class FakeCascade extends EventEmitter {
      readonly cascadeId = "casc-gen-1";
      dispose() {
        disposed = true;
      }
    }
    const fakeCascade = new FakeCascade();

    let currentGen = 1;
    const fakeLsConnection: any = new EventEmitter();
    Object.defineProperty(fakeLsConnection, "generation", {
      get: () => currentGen,
    });
    fakeLsConnection.ensureClient = async () => ({
      resumeCascade: async () => fakeCascade,
      startCascade: async () => fakeCascade,
    });

    const bindingStore = BindingStore.inMemory();
    const cm = new CascadeManager(fakeLsConnection, bindingStore, false);

    // Turn 1 under generation 1
    const t1 = await cm.ensureTurnCascade({
      sessionId: "test-sess",
      branch: [{ id: "m1", role: "user", content: "hello" }],
      modelId: 100,
      systemPrompt: "sys",
    });

    assert.strictEqual(t1.cascade.cascadeId, "casc-gen-1");
    assert.strictEqual(t1.isFreshCascade, true);
    assert.strictEqual(cm.getActiveCascade("test-sess")?.cascadeId, "casc-gen-1");
    assert.strictEqual(disposed, false);

    // LS restarts -> generation advances to 2
    currentGen = 2;

    class FakeNewCascade extends EventEmitter {
      readonly cascadeId = "casc-gen-2";
      dispose() {}
    }
    const fakeNewCascade = new FakeNewCascade();
    fakeLsConnection.ensureClient = async () => ({
      resumeCascade: async () => {
        throw new Error("Cascade not found on new LS");
      },
      startCascade: async () => fakeNewCascade,
    });

    // Turn 2 under generation 2
    const t2 = await cm.ensureTurnCascade({
      sessionId: "test-sess",
      branch: [
        { id: "m1", role: "user", content: "hello" },
        { id: "m2", role: "assistant", content: [{ type: "text", text: "world" }] },
        { id: "m3", role: "user", content: "next prompt" },
      ],
      modelId: 100,
      systemPrompt: "sys",
      priorHistory: "[User]: hello\n\n[Assistant]: world",
    });

    assert.strictEqual(disposed, true, "Stale cascade from generation 1 must be disposed");
    assert.strictEqual(t2.cascade.cascadeId, "casc-gen-2");
    assert.strictEqual(t2.isFreshCascade, true);
    assert.strictEqual(cm.getActiveCascade("test-sess")?.cascadeId, "casc-gen-2");
    assert.ok(
      t2.priorHistory.includes("[User]: hello"),
      `Prior history must be injected into fresh cascade, got: ${t2.priorHistory}`
    );
  });

  it("injects prior conversation history serialized from branch when resumeCascade fails and priorHistory is omitted (D-03)", async () => {
    const fakeLsConnection: any = new EventEmitter();
    Object.defineProperty(fakeLsConnection, "generation", {
      get: () => 2,
    });

    class FakeNewCascade extends EventEmitter {
      readonly cascadeId = "casc-resumed-fallback";
      dispose() {}
    }
    const fakeNew = new FakeNewCascade();

    fakeLsConnection.ensureClient = async () => ({
      resumeCascade: async () => {
        throw new Error("Cascade expired / missing on LS");
      },
      startCascade: async () => fakeNew,
    });

    const bindingStore = BindingStore.inMemory();
    bindingStore.set("test-sess-failover", {
      cascadeId: "old-dead-id",
      lastLeafId: "m2",
      steps: { m1: 1, m2: 2 },
      priorHistory: "",
    });

    const cm = new CascadeManager(fakeLsConnection, bindingStore, false);

    // Omit ctx.priorHistory to verify CascadeManager computes fallback from branch
    const t = await cm.ensureTurnCascade({
      sessionId: "test-sess-failover",
      branch: [
        { id: "m1", role: "user", content: "Turn 1 secret CODE-77" },
        { id: "m2", role: "assistant", content: [{ type: "text", text: "Turn 1 reply" }] },
        { id: "m3", role: "user", content: "Turn 2" },
      ],
      modelId: 100,
      systemPrompt: "sys",
    });

    assert.strictEqual(t.cascade.cascadeId, "casc-resumed-fallback");
    assert.strictEqual(t.isFreshCascade, true);
    assert.ok(t.priorHistory.includes("Turn 1 secret CODE-77"));
    assert.ok(t.priorHistory.includes("Turn 1 reply"));

    const updatedBinding = bindingStore.get("test-sess-failover");
    assert.strictEqual(updatedBinding?.cascadeId, "casc-resumed-fallback");
    assert.deepStrictEqual(updatedBinding?.steps, {});
    assert.ok(updatedBinding?.priorHistory?.includes("Turn 1 secret CODE-77"));
  });

  it("skips resuming dead tool-loop cascade when LS generation changes on toolResult leaf (D-02, D-03)", async () => {
    let currentGen = 1;
    let resumeCalled = false;

    class FakeCascade1 extends EventEmitter {
      readonly cascadeId = "casc-tool-1";
      dispose() {}
    }
    class FakeCascade2 extends EventEmitter {
      readonly cascadeId = "casc-tool-2";
      dispose() {}
    }

    const fakeLsConnection: any = new EventEmitter();
    Object.defineProperty(fakeLsConnection, "generation", {
      get: () => currentGen,
    });
    fakeLsConnection.ensureClient = async () => ({
      resumeCascade: async () => {
        resumeCalled = true;
        return new FakeCascade1();
      },
      startCascade: async () => (currentGen === 1 ? new FakeCascade1() : new FakeCascade2()),
    });

    const bindingStore = BindingStore.inMemory();
    const cm = new CascadeManager(fakeLsConnection, bindingStore, false);

    // Turn 1 starts on generation 1
    await cm.ensureTurnCascade({
      sessionId: "tool-sess",
      branch: [{ id: "u1", role: "user", content: "read foo.txt" }],
      modelId: 100,
      systemPrompt: "sys",
    });

    // LS dies during tool execution; generation advances to 2
    currentGen = 2;

    const t2 = await cm.ensureTurnCascade({
      sessionId: "tool-sess",
      branch: [
        { id: "u1", role: "user", content: "read foo.txt" },
        {
          id: "a1",
          role: "assistant",
          provider: "antigravity-ls",
          content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "foo.txt" } }],
        },
        {
          id: "tr1",
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "read",
          content: [{ type: "text", text: "file-contents-xyz" }],
        },
      ],
      modelId: 100,
      systemPrompt: "sys",
    });

    assert.strictEqual(resumeCalled, false, "Must not resume a dead in-flight tool-loop cascade across LS restart");
    assert.strictEqual(t2.cascade.cascadeId, "casc-tool-2");
    assert.strictEqual(t2.isFreshCascade, true);
    assert.ok(t2.priorHistory.includes("file-contents-xyz"));
  });
});
