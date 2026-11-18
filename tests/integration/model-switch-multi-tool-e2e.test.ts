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

describe("Model Switch Gemini -> Claude Multi-Tool E2E", { skip: !HAS_LS_BINARY }, () => {
  it("switches from Gemini 3.8 Flash to Claude Sonnet 5.5 and executes parallel tool calls without hanging", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = BindingStore.inMemory();
    const modelCatalog = new ModelCatalog();

    const mockTools = [
      {
        name: "read",
        description: "Read file contents",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string" },
            offset: { type: "number" },
            limit: { type: "number" },
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

    const geminiModel = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const claudeModel = {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const sessionId = "e2e-switch-session-" + Date.now();
    const messages: any[] = [
      {
        role: "system",
        content: "You are an expert AI software engineer. Be direct and concise.",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Read package.json using the read tool and tell me the package name." }],
      },
    ];

    async function runAgentTurn(model: any) {
      let turnStep = 0;
      while (turnStep++ < 8) {
        const stream = streamSimple(model, { messages } as any, { sessionId, reasoning: "high" });
        for await (const _ of stream) {
          // consume deltas
        }
        const result = await stream.result();
        messages.push(result);

        if (result.stopReason === "toolUse") {
          const toolCalls = (result.content.filter((b: any) => b.type === "toolCall")) as any[];
          for (const tc of toolCalls) {
            const toolResultEvent = {
              toolCallId: tc.id,
              toolName: tc.name,
              content: [
                {
                  type: "text",
                  text: `Mock file content for ${tc.arguments?.path || "file"}: export const test = 123;`,
                },
              ],
              isError: false,
            };

            // D-01: stage result on tool_result
            roundTrip.stageResult(tc.id, toolResultEvent);

            messages.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: toolResultEvent.content,
            });

            await new Promise((r) => setTimeout(r, 10));
          }
          continue;
        }

        return result;
      }
      throw new Error("Turn exceeded max tool steps");
    }

    try {
      // ── Turn 1: Gemini 3.8 Flash ──
      const startTime = Date.now();
      const geminiResult = await runAgentTurn(geminiModel);
      assert.strictEqual(geminiResult.stopReason, "stop");

      // Verify binding exists and recorded steps
      const binding = bindingStore.get(sessionId);
      assert.ok(binding?.cascadeId, "Binding must record cascadeId");

      // ── Turn 2: Switch to Claude Sonnet 5.5 in the SAME Cascade ──
      messages.push({
        role: "user",
        content: [
          {
            type: "text",
            text: "Now read BOTH src/index.ts and src/models.ts in parallel right now, then briefly summarize both.",
          },
        ],
      });

      const claudeResult = await runAgentTurn(claudeModel);
      const totalDuration = Date.now() - startTime;

      assert.strictEqual(claudeResult.stopReason, "stop");
      const claudeText = claudeResult.content
        .filter((b: any) => b.type === "text")
        .map((b: any) => b.text)
        .join("\n");
      assert.ok(claudeText.length > 0, "Claude must return a text response");
      // Total duration for both turns should comfortably finish under 40 seconds (no 120s timeout!)
      assert.ok(
        totalDuration < 40000,
        `Expected both turns to complete within 40s without hang, took ${totalDuration}ms`
      );
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
