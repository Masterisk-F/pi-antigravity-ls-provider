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

describe("Multi-Tool Sequential Dispatch & Deadlock Prevention Integration (D-01)", { skip: !HAS_LS_BINARY }, () => {
  it("stages tool results during inter-turn gap and flushes upon stream listener attachment without event loss", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = new BindingStore("/tmp/test-bindings-multi-deadlock.json");
    const modelCatalog = new ModelCatalog();

    const mockTools = [
      {
        name: "read",
        description: "Read file contents",
        parameters: {
          type: "object",
          required: ["path"],
          properties: { path: { type: "string" } },
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

    const model = {
      id: "claude-sonnet-5-5",
      name: "Claude Sonnet 5.5",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const sessionId = "test-multi-tool-deadlock-session-" + Date.now();
    const messages: any[] = [
      {
        role: "system",
        content: "You are a concise assistant. When asked to read files, read them and summarize.",
      },
      {
        role: "user",
        content: [{ type: "text", text: "Read BOTH src/index.ts and src/models.ts in parallel right now." }],
      },
    ];

    const executedTools: string[] = [];

    try {
      // Simulate Pi's agent loop:
      // Turn 1: streamSimple -> toolUse
      let turnCount = 0;
      let finalResponse = "";

      while (turnCount++ < 10) {
        const stream = streamSimple(model, { messages } as any, { sessionId, reasoning: "high" });

        for await (const event of stream) {
          if (event.type === "text_delta") {
            finalResponse += event.delta;
          }
        }

        const result = await stream.result();
        messages.push(result);

        if (result.stopReason === "toolUse") {
          const toolCalls = (result.content.filter((b: any) => b.type === "toolCall")) as any[];
          assert.ok(toolCalls.length > 0, "Expected at least one tool call in toolUse turn");

          for (const tc of toolCalls) {
            executedTools.push(tc.name);
            const toolResultEvent = {
              toolCallId: tc.id,
              toolName: tc.name,
              content: [{ type: "text", text: `Mock file content for ${tc.arguments?.path || tc.name}` }],
              isError: false,
            };

            // D-01: pi.on("tool_result") stages the result
            const staged = roundTrip.stageResult(tc.id, toolResultEvent);
            assert.strictEqual(staged, true, "Tool result must be staged in RoundTrip");

            messages.push({
              role: "toolResult",
              toolCallId: tc.id,
              toolName: tc.name,
              content: toolResultEvent.content,
            });

            // Simulate slight delay between tool execution and next streamSimple call
            await new Promise((r) => setTimeout(r, 15));
          }
          continue;
        }

        // Final text response reached
        assert.strictEqual(result.stopReason, "stop");
        break;
      }

      assert.ok(executedTools.length >= 2, `Expected at least 2 tool executions, got ${executedTools.length}`);
      assert.ok(finalResponse.length > 0, "Expected final model answer text");
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
      try {
        fs.unlinkSync("/tmp/test-bindings-multi-deadlock.json");
      } catch {
        // ignore
      }
    }
  });

  it("flushes staged terminating tool results during agent_settled before cascade cancellation", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = new BindingStore("/tmp/test-bindings-settled.json");
    const modelCatalog = new ModelCatalog();

    const mockTools = [
      {
        name: "plannotator_submit_plan",
        description: "Submit plan for review",
        parameters: {
          type: "object",
          required: ["filePath"],
          properties: { filePath: { type: "string" } },
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

    const model = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const sessionId = "test-settled-session-" + Date.now();
    const messages = [
      {
        role: "system",
        content: "You are a planning assistant. When asked to submit a plan, call plannotator_submit_plan.",
      },
      {
        role: "user",
        content: "Please submit PLAN.md for review.",
      },
    ];

    try {
      const stream = streamSimple(model, { messages } as any, { sessionId });
      let toolCallId = "";

      for await (const event of stream) {
        if (event.type === "toolcall_end") {
          toolCallId = event.toolCall.id;
        }
      }

      const turnResult = await stream.result();
      assert.strictEqual(turnResult.stopReason, "toolUse");
      assert.ok(toolCallId.length > 0);

      // 1. Tool result staged via pi.on("tool_result")
      const toolResultEvent = {
        toolCallId,
        toolName: "plannotator_submit_plan",
        content: [{ type: "text", text: "Plan submitted for review." }],
        details: { approved: false, pending: true },
        isError: false,
      };
      const staged = roundTrip.stageResult(toolCallId, toolResultEvent);
      assert.strictEqual(staged, true);
      assert.strictEqual(roundTrip.hasStagedResults(), true);

      // 2. pi.on("agent_settled") flushes staged results and cancels cascade
      const flushed = roundTrip.flushStagedResults();
      assert.strictEqual(flushed, 1, "agent_settled must flush all staged tool results");
      assert.strictEqual(roundTrip.hasStagedResults(), false);

      roundTrip.abortAll("Agent settled");
      await cascadeManager.cancelCascade(sessionId);
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
      try {
        fs.unlinkSync("/tmp/test-bindings-settled.json");
      } catch {
        // ignore
      }
    }
  });
});
