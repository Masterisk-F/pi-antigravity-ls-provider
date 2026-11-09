import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LsConnection } from "../../src/ls-connection.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";
import { createStreamSimple } from "../../src/provider-stream.js";

const HAS_LS_BINARY = fs.existsSync("/opt/Antigravity/resources/bin/language_server");

/**
 * End-to-end proof that a conversation held on another provider is carried into
 * Antigravity LS when the model is switched mid-session.
 */
describe("Cross-provider conversation history (E2E)", { skip: !HAS_LS_BINARY }, () => {
  it("replays Claude turns and tool results into a Gemini session", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = new BindingStore(
      path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agls-e2e-")), "bindings.json")
    );
    const modelCatalog = new ModelCatalog();

    const mcpServer = new McpBridgeServer({ toolsProvider: () => [], roundTrip });
    await mcpServer.start();

    const lsConnection = new LsConnection({ mcpServer, verbose: false });
    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
    const sessionId = "test-cross-provider-history";

    const streamSimple = createStreamSimple({
      lsConnection,
      cascadeManager,
      roundTrip,
      modelCatalog,
      mcpServer,
      verbose: false,
    });

    const model = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    // Two turns held with Claude, including a tool call and its result, then the
    // first turn issued after switching to this provider.
    const historyMessages = [
      { role: "system", content: "You are a concise coding assistant.", timestamp: 1 },
      { role: "user", content: "The project codename is ZETA-9 and redis runs on port 6389.", timestamp: 2 },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        api: "anthropic-messages",
        content: [{ type: "text", text: "Understood: ZETA-9 on port 6389." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: 3,
      },
      { role: "user", content: "Please read config.yaml now.", timestamp: 4 },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        api: "anthropic-messages",
        content: [
          { type: "text", text: "Reading config.yaml." },
          { type: "toolCall", id: "call_cfg", name: "read", arguments: { path: "config.yaml" } },
        ],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "toolUse",
        timestamp: 5,
      },
      {
        role: "toolResult",
        toolCallId: "call_cfg",
        toolName: "read",
        content: [{ type: "text", text: "database:\n  name: nova_core\n  replica: nova_core_replica" }],
        isError: false,
        timestamp: 6,
      },
      {
        role: "assistant",
        provider: "anthropic",
        model: "claude-sonnet-5-5",
        api: "anthropic-messages",
        content: [{ type: "text", text: "The database name is nova_core with replica nova_core_replica." }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        stopReason: "stop",
        timestamp: 7,
      },
    ];

    try {
      // ── Turn 1: after switching to Antigravity ──
      const context1 = {
        messages: [
          ...historyMessages,
          {
            role: "user",
            content: "What is the project codename, the redis port, and the database replica name? Answer briefly.",
            timestamp: 8,
          },
        ],
      };

      const stream1 = streamSimple(model, context1 as any, { sessionId });
      let text1 = "";
      for await (const event of stream1) {
        if (event.type === "text_delta") text1 += event.delta;
      }
      const result1 = await stream1.result();

      assert.strictEqual(result1.stopReason, "stop");
      assert.ok(/ZETA-9/i.test(text1), `expected codename ZETA-9 in: ${text1}`);
      assert.ok(text1.includes("6389"), `expected redis port 6389 in: ${text1}`);
      assert.ok(
        /nova_core_replica/i.test(text1),
        `expected tool-result content (replica name) in: ${text1}`
      );

      const binding1 = bindingStore.get(sessionId);
      assert.ok(binding1?.cascadeId, "expected a cascade to be recorded");
      assert.ok(
        (binding1?.priorHistory ?? "").includes("ZETA-9"),
        "binding must persist the replayed history"
      );

      // ── Turn 2: same Cascade continues, history must not be duplicated ──
      const context2 = {
        messages: [
          ...context1.messages,
          {
            role: "assistant",
            provider: "antigravity-ls",
            model: "gemini-3.8-flash",
            api: "antigravity-ls",
            content: [{ type: "text", text: text1 }],
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
            stopReason: "stop",
            timestamp: 9,
          },
          {
            role: "user",
            content: "Repeat only the redis port number.",
            timestamp: 10,
          },
        ],
      };

      const stream2 = streamSimple(model, context2 as any, { sessionId });
      let text2 = "";
      for await (const event of stream2) {
        if (event.type === "text_delta") text2 += event.delta;
      }
      const result2 = await stream2.result();

      assert.strictEqual(result2.stopReason, "stop");
      assert.ok(text2.includes("6389"), `expected the port in the continuation turn: ${text2}`);

      const binding2 = bindingStore.get(sessionId);
      assert.strictEqual(
        binding2?.cascadeId,
        binding1?.cascadeId,
        "the same Cascade must serve the continuation turn"
      );
      assert.strictEqual(
        binding2?.priorHistory,
        binding1?.priorHistory,
        "priorHistory must stay fixed so it is not re-appended to the trajectory"
      );
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
