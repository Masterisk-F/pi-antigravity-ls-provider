import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import { LsConnection, ANTIGRAVITY_IDE_VERSION } from "../../src/ls-connection.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import { buildCascadeConfig } from "../../src/cascade-config.js";

const HAS_LS_BINARY = fs.existsSync("/opt/Antigravity/resources/bin/language_server");

describe("Tool Execution E2E with gemini-3.8-flash (Integration)", { skip: !HAS_LS_BINARY }, () => {
  it("executes bash tool via round-trip on gemini-3.8-flash without 3-minute timeout hang", async () => {
    const roundTrip = new RoundTrip();
    const modelCatalog = new ModelCatalog();

    const mockTools = [
      {
        name: "bash",
        description: "Execute bash command",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Shell command to run" },
          },
        },
      },
    ];

    const mcpServer = new McpBridgeServer({
      toolsProvider: () => mockTools as any,
      roundTrip,
    });

    await mcpServer.start();

    const lsConnection = new LsConnection({
      mcpServer,
    });

    let toolCallReceived = false;
    let receivedCommand = "";

    roundTrip.on("park", (p) => {
      toolCallReceived = true;
      receivedCommand = p.args?.command || "";
      // Immediately resolve tool call with mock file list
      roundTrip.resolve(p.callId, "sample_output.txt");
    });

    try {
      const client = await lsConnection.ensureClient();
      const cascade = await client.startCascade();

      let outputText = "";
      cascade.on("text", (d) => {
        outputText += d.delta;
      });

      // Resolve model: gemini-3.8-flash (default effort: medium -> 1319)
      const { numericId: modelId, modelName } = modelCatalog.resolveModel("gemini-3.8-flash");
      assert.strictEqual(modelId, 1319, "gemini-3.8-flash medium must resolve to numericId 1319");

      const cfg = buildCascadeConfig({
        modelId,
        modelName,
        systemPrompt: "You are a coding assistant. When asked to list files, use the bash tool with 'ls'.",
        mcpServerName: mcpServer.serverName,
      });

      const startTime = Date.now();

      await client.lsClient.sendUserCascadeMessage({
        metadata: {
          apiKey: "",
          ideName: "vscode",
          ideVersion: ANTIGRAVITY_IDE_VERSION,
          extensionName: "antigravity",
          extensionVersion: "0.2.0",
        },
        cascadeId: cascade.cascadeId,
        items: [{ chunk: { case: "text", value: "List files in /tmp using the bash tool." } }],
        blocking: false,
        clientType: 1,
        cascadeConfig: cfg as any,
      });

      // Wait for turn to complete (running -> idle) with 50s timeout (must NOT hang for 3 minutes!)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Timeout waiting for turn completion")), 50000);
        let wasRunning = false;
        cascade.on("statusChange", (ev) => {
          if (ev.status === "running") wasRunning = true;
          if (wasRunning && ev.status === "idle") {
            clearTimeout(timer);
            resolve();
          }
        });
      });

      const durationMs = Date.now() - startTime;

      assert.strictEqual(toolCallReceived, true, "Tool call must be intercepted by roundTrip");
      assert.ok(receivedCommand.includes("ls"), "Model should call ls command via bash");
      assert.ok(durationMs < 45000, `Execution should finish within 45s (took ${durationMs}ms)`);
      assert.ok(outputText.length > 0, "Model should generate final text output after tool completion");

      cascade.dispose();
    } finally {
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
