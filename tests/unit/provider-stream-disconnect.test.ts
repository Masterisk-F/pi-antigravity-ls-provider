import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStreamSimple } from "../../src/provider-stream.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";

describe("ProviderStream Immediate Disconnect Detection (Unit - D-04)", () => {
  it("terminates stream immediately with error when lsConnection emits exit during turn", async () => {
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    class FakeCascade extends EventEmitter {
      readonly cascadeId = "fake-disc-cascade";
      dispose() {}
      async cancel() {}
    }
    const fakeCascade = new FakeCascade();

    const fakeLsConnection: any = new EventEmitter();
    fakeLsConnection.generation = 1;
    fakeLsConnection.ensureClient = async () => ({
      lsClient: {
        sendUserCascadeMessage: async () => {},
      },
    });

    const fakeCascadeManager: any = {
      ensureTurnCascade: async () => ({ cascade: fakeCascade, priorHistory: "", isFreshCascade: true }),
      recordTurnEnd: async () => {},
    };

    const streamSimple = createStreamSimple({
      lsConnection: fakeLsConnection,
      cascadeManager: fakeCascadeManager,
      roundTrip,
      modelCatalog,
    });

    const model = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const stream = streamSimple(model, {
      messages: [{ role: "user", content: "hello" }],
    } as any);

    const startTime = Date.now();
    setTimeout(() => {
      fakeCascade.emit("statusChange", { status: "running" });
      setTimeout(() => {
        fakeLsConnection.emit("exit", { code: 137, signal: "SIGKILL" });
      }, 20);
    }, 10);

    const events: any[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }
    const result = await stream.result();
    const elapsed = Date.now() - startTime;

    assert.ok(elapsed < 2000, `Expected stream to terminate immediately, took ${elapsed}ms`);
    assert.strictEqual(result.stopReason, "error");
    assert.ok(
      result.errorMessage?.includes("Antigravity LS process exited unexpectedly"),
      `Expected error message to mention LS process exit, got: ${result.errorMessage}`
    );

    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Stream must emit error event");
    assert.strictEqual(errorEvent.reason, "error");
  });

  it("dispatches continuation prompt with priorHistory when a fresh cascade handles a toolResult leaf", async () => {
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    class FakeCascade extends EventEmitter {
      readonly cascadeId = "fake-fresh-tool-cont";
      state = { status: 1 };
      dispose() {}
      async cancel() {}
    }
    const fakeCascade = new FakeCascade();

    const sentRequests: any[] = [];
    const fakeLsConnection: any = new EventEmitter();
    fakeLsConnection.generation = 2;
    fakeLsConnection.ensureClient = async () => ({
      lsClient: {
        sendUserCascadeMessage: async (req: any) => {
          sentRequests.push(req);
          setTimeout(() => {
            fakeCascade.emit("statusChange", { status: "running" });
            fakeCascade.emit("text", { delta: "Continued from tool result" });
            fakeCascade.emit("statusChange", { status: "idle" });
          }, 10);
        },
        getCascadeTrajectoryGeneratorMetadata: async () => ({ generatorMetadata: [] }),
      },
    });

    const fakeCascadeManager: any = {
      ensureTurnCascade: async () => ({
        cascade: fakeCascade,
        priorHistory: "[User]: read foo\n\n[Tool result (read)]: bar-content",
        isFreshCascade: true,
      }),
      recordTurnEnd: async () => {},
    };

    const streamSimple = createStreamSimple({
      lsConnection: fakeLsConnection,
      cascadeManager: fakeCascadeManager,
      roundTrip,
      modelCatalog,
    });

    const model = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const stream = streamSimple(model, {
      messages: [
        { id: "u1", role: "user", content: "read foo" },
        {
          id: "a1",
          role: "assistant",
          provider: "antigravity-ls",
          content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "foo" } }],
        },
        {
          id: "tr1",
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "bar-content" }],
        },
      ],
    } as any);

    for await (const _ of stream) {}
    const result = await stream.result();

    assert.strictEqual(result.stopReason, "stop");
    assert.strictEqual(sentRequests.length, 1);
    const sections = sentRequests[0].cascadeConfig.plannerConfig.plannerTypeConfig.value.promptSections;
    const historySection = sections.find((s: any) => s.item?.value?.title === "conversation_history");
    assert.ok(historySection, "Fresh cascade must receive conversation_history section");
    assert.ok(historySection.item.value.content.includes("bar-content"));
  });
});
