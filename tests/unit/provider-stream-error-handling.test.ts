import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import { createStreamSimple } from "../../src/provider-stream.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";

class FakeCascade extends EventEmitter {
  readonly cascadeId = "casc-test-err";
  cancelled = false;
  disposed = false;

  async cancel() {
    this.cancelled = true;
  }
  dispose() {
    this.disposed = true;
  }
}

describe("provider-stream Error Handling & Hang Prevention (Unit - D-02, D-04)", () => {
  it("immediately terminates stream with error when Language Server produces an errorMessage step (D-02)", async () => {
    const fakeCascade = new FakeCascade();
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    const mockLsConnection: any = {
      ensureClient: async () => ({
        lsClient: {
          sendUserCascadeMessage: async () => {},
        },
      }),
    };

    const mockCascadeManager: any = {
      ensureTurnCascade: async () => ({
        cascade: fakeCascade,
        priorHistory: "",
      }),
      recordTurnEnd: async () => {},
    };

    const streamSimple = createStreamSimple({
      lsConnection: mockLsConnection,
      cascadeManager: mockCascadeManager,
      roundTrip,
      modelCatalog,
      verbose: false,
    });

    const stream = streamSimple(
      {
        id: "antigravity-ls/gemini-3.8-flash",
        api: "antigravity-ls" as any,
        provider: "antigravity-ls",
      } as any,
      {
        messages: [{ role: "user", content: "trigger error test" }],
      } as any
    );

    const events: any[] = [];
    const eventPromise = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();

    // Emit errorMessage step after stream is created
    setTimeout(() => {
      fakeCascade.emit("stepNew", {
        step: {
          type: "errorMessage",
          status: "done",
          raw: {
            errorMessage: {
              error: {
                userErrorMessage: "Agent execution terminated due to error.",
                shortError: "failed to construct executor: validation failed",
              },
            },
          },
        },
      });
    }, 50);

    // Wait for stream to process the event
    const finalMessage = await stream.result();
    await eventPromise;

    assert.strictEqual(finalMessage.stopReason, "error");
    assert.ok(
      finalMessage.errorMessage?.includes("Agent execution terminated due to error.") ||
      finalMessage.errorMessage?.includes("failed to construct executor")
    );
    const errorEv = events.find((e) => e.type === "error");
    assert.ok(errorEv, "stream must emit an error event without hanging");
  });

  it("handles numeric type 17 errorMessage step format identically (D-02)", async () => {
    const fakeCascade = new FakeCascade();
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    const mockLsConnection: any = {
      ensureClient: async () => ({
        lsClient: {
          sendUserCascadeMessage: async () => {},
        },
      }),
    };

    const mockCascadeManager: any = {
      ensureTurnCascade: async () => ({
        cascade: fakeCascade,
        priorHistory: "",
      }),
      recordTurnEnd: async () => {},
    };

    const streamSimple = createStreamSimple({
      lsConnection: mockLsConnection,
      cascadeManager: mockCascadeManager,
      roundTrip,
      modelCatalog,
      verbose: false,
    });

    const stream = streamSimple(
      {
        id: "antigravity-ls/gemini-3.8-flash",
        api: "antigravity-ls" as any,
        provider: "antigravity-ls",
      } as any,
      {
        messages: [{ role: "user", content: "test 17" }],
      } as any
    );

    setTimeout(() => {
      fakeCascade.emit("stepNew", {
        step: {
          type: 17,
          raw: {
            step: {
              value: {
                error: {
                  userErrorMessage: "Agent execution terminated due to error.",
                },
              },
            },
          },
        },
      });
    }, 20);

    const finalMessage = await stream.result();
    assert.strictEqual(finalMessage.stopReason, "error");
    assert.ok(finalMessage.errorMessage?.includes("Agent execution terminated due to error."));
  });
});
