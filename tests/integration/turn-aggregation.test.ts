import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import { LsConnection } from "../../src/ls-connection.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";
import { createStreamSimple } from "../../src/provider-stream.js";

const HAS_LS_BINARY = fs.existsSync("/opt/Antigravity/resources/bin/language_server");

describe("Sequential User Messages Integration", { skip: !HAS_LS_BINARY }, () => {
  it("sequentially dispatches user prompts so Language Server receives both user input and framing", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = new BindingStore();
    const modelCatalog = new ModelCatalog();

    const mcpServer = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip,
    });
    await mcpServer.start();

    const lsConnection = new LsConnection({
      mcpServer,
      verbose: false,
    });

    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);

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

    // Simulate pi context where user prompt is followed by plannotator framing custom_message
    const context = {
      messages: [
        {
          role: "system",
          content: "You are a concise coding assistant.",
        },
        {
          role: "user",
          content: [{ type: "text", text: "Secret keyword is PHOENIX." }],
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "[PLANNOTATOR - PLANNING PHASE]\nWhat is the secret keyword? Reply with only the keyword.",
            },
          ],
        },
      ],
    };

    const stream = streamSimple(model, context as any, {
      sessionId: "test-turn-aggregation",
    });

    let fullText = "";
    for await (const event of stream) {
      if (event.type === "text_delta") {
        fullText += event.delta;
      }
    }

    const result = await stream.result();

    try {
      // 1. Verify model output contains the secret from the first user prompt
      assert.ok(
        fullText.toUpperCase().includes("PHOENIX"),
        `Expected model to include PHOENIX, got: ${fullText}`
      );
      assert.strictEqual(result.stopReason, "stop");

      // 2. Verify trajectory steps on Language Server side
      const client = await lsConnection.ensureClient();
      const binding = bindingStore.get("test-turn-aggregation");
      assert.ok(binding?.cascadeId, "Expected cascadeId to be recorded in binding");

      const hist = await client.lsClient.getCascadeTrajectory({
        cascadeId: binding.cascadeId,
      });

      const steps = hist.trajectory?.steps || [];
      // Step 0: User Prompt 1
      // Step 1: User Prompt 2 (Framing)
      // Step 2: Planner Response
      assert.ok(steps.length >= 3, `Expected at least 3 steps, got ${steps.length}`);
      assert.strictEqual(steps[0].type, 14, "Step 0 should be USER_INPUT");
      assert.strictEqual(steps[1].type, 14, "Step 1 should be USER_INPUT");
      assert.strictEqual(steps[2].type, 15, "Step 2 should be PLANNER_RESPONSE");
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
