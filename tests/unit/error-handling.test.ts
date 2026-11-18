import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { isLegacyServer, ANTIGRAVITY_IDE_VERSION } from "../../src/ls-connection.js";
import { createStreamSimple } from "../../src/provider-stream.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import type { ServerInfo } from "antigravity-client";

describe("ANTIGRAVITY_IDE_VERSION & Legacy Server Detection (Unit)", () => {
  it("exports official latest IDE version 2.28.1", () => {
    assert.strictEqual(ANTIGRAVITY_IDE_VERSION, "2.28.1");
  });

  it("returns false for server without pid or unreadable cmdline", () => {
    const s1: ServerInfo = {
      pid: 0,
      httpPort: 0,
      httpsPort: 1234,
      csrfToken: "t",
      workspaceId: "w",
      startTime: new Date(),
    };
    assert.strictEqual(isLegacyServer(s1), false);

    const s2: ServerInfo = {
      pid: 999999999, // non-existent PID
      httpPort: 0,
      httpsPort: 1234,
      csrfToken: "t",
      workspaceId: "w",
      startTime: new Date(),
    };
    assert.strictEqual(isLegacyServer(s2), false);
  });
});

describe("Trajectory Error Detection on Premature Idle (Unit)", () => {
  it("emits error event and sets stopReason=error when LS fails with CORTEX_STEP_TYPE_ERROR_MESSAGE without output", async () => {
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    // Fake Cascade emitting statusChange idle immediately after running
    class FakeCascade extends EventEmitter {
      readonly cascadeId = "fake-err-cascade";
      dispose() {}
      async cancel() {}
    }
    const fakeCascade = new FakeCascade();

    const fakeLsClient = {
      sendUserCascadeMessage: async () => {},
      getCascadeTrajectoryGeneratorMetadata: async () => ({ generatorMetadata: [] }),
      getCascadeTrajectory: async () => ({
        trajectory: {
          steps: [
            {
              type: "CORTEX_STEP_TYPE_USER_INPUT",
              status: "CORTEX_STEP_STATUS_DONE",
            },
            {
              type: "CORTEX_STEP_TYPE_ERROR_MESSAGE",
              status: "CORTEX_STEP_STATUS_DONE",
              errorMessage: {
                error: {
                  shortError: "failed to construct executor: unknown model key MODEL_PLACEHOLDER_M318: model not found",
                  userErrorMessage: "Agent execution terminated due to error.",
                },
              },
            },
          ],
        },
      }),
    };

    const fakeLsConnection: any = {
      ensureClient: async () => ({
        lsClient: fakeLsClient,
      }),
    };

    const fakeCascadeManager: any = {
      ensureTurnCascade: async () => ({ cascade: fakeCascade, priorHistory: "" }),
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

    const stream = streamSimple(model, { messages: [{ role: "user", content: "test" }] } as any);

    // Emit running then idle to simulate LS failure
    setTimeout(() => {
      fakeCascade.emit("statusChange", { status: "running" });
      setTimeout(() => {
        fakeCascade.emit("statusChange", { status: "idle" });
      }, 10);
    }, 10);

    const events: any[] = [];
    for await (const ev of stream) {
      events.push(ev);
    }
    const result = await stream.result();

    assert.strictEqual(result.stopReason, "error");
    assert.ok(
      result.errorMessage?.includes("MODEL_PLACEHOLDER_M318"),
      `Expected error message to contain MODEL_PLACEHOLDER_M318, got: ${result.errorMessage}`
    );

    const errorEvent = events.find((e) => e.type === "error");
    assert.ok(errorEvent, "Stream must emit error event");
    assert.strictEqual(errorEvent.reason, "error");
  });
});
