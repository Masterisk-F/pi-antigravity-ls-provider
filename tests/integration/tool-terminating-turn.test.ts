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

describe("Terminating Tool Turn & Subsequent Prompt Integration", { skip: !HAS_LS_BINARY }, () => {
  it("resolves terminating tool call, cancels invocation on settle, and cleanly executes subsequent user turn", async () => {
    const roundTrip = new RoundTrip();
    const bindingStore = new BindingStore();
    const modelCatalog = new ModelCatalog();

    const mockTools = [
      {
        name: "plannotator_submit_plan",
        description: "Submit plan for reviewer approval",
        parameters: {
          type: "object",
          required: ["filePath"],
          properties: {
            filePath: { type: "string", description: "Path to plan markdown file" },
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

    const model = {
      id: "gemini-3.8-flash",
      name: "Gemini 3.8 Flash",
      provider: "antigravity-ls",
      api: "antigravity-ls",
    } as any;

    const sessionId = "test-terminating-turn-session";

    try {
      // ── Turn 1: Planning phase, model calls plannotator_submit_plan ──
      const turn1Context = {
        messages: [
          {
            role: "system",
            content: "You are a planning assistant. When asked to submit a plan, call plannotator_submit_plan.",
          },
          {
            role: "user",
            content: "Please submit PLAN.md for review.",
          },
        ],
      };

      const stream1 = streamSimple(model, turn1Context as any, { sessionId });

      let toolCallId = "";
      let toolName = "";

      for await (const event of stream1) {
        if (event.type === "toolcall_end") {
          toolCallId = event.toolCall.id;
          toolName = event.toolCall.name;
        }
      }

      const turn1Result = await stream1.result();
      assert.strictEqual(turn1Result.stopReason, "toolUse");
      assert.strictEqual(toolName, "plannotator_submit_plan");
      assert.ok(toolCallId.length > 0);

      // Simulate Pi's execution of plannotator_submit_plan
      // Tool returns terminate: true, so Pi emits tool_result and settles
      const toolResultEvent = {
        toolCallId,
        toolName,
        content: [
          {
            type: "text",
            text: "Plan PLAN.md submitted for review in Plannotator. The reviewer's decision will arrive later as a new message. Do not start implementing: end your turn now and wait.",
          },
        ],
        details: { approved: false, pending: true },
        isError: false,
      };

      // D-02: pi.on("tool_result") resolves parked MCP call
      const resolved = roundTrip.resolve(toolCallId, toolResultEvent);
      assert.strictEqual(resolved, true, "Parked MCP tool call must be resolved by tool_result hook");

      // D-03: pi.on("agent_settled") cancels invocation to deterministically stop LS
      await cascadeManager.cancelCascade(sessionId);

      // ── Turn 2: User approves plan in Plannotator UI ──
      // Pi starts new turn with approved plan user prompt + executing framing
      const turn2Context = {
        messages: [
          ...turn1Context.messages,
          turn1Result, // assistant message that invoked plannotator_submit_plan
          {
            role: "toolResult",
            toolCallId,
            toolName,
            content: toolResultEvent.content,
          },
          {
            role: "user",
            content: "Plan approved. You now have full tool access. Execute the plan in PLAN.md. Please reply with: EXECUTION_STARTED.",
          },
          {
            role: "user",
            content: "[PLANNOTATOR - EXECUTING PLAN]\nThe planning phase is over. Execute the plan.",
          },
        ],
      };

      const stream2 = streamSimple(model, turn2Context as any, { sessionId });

      let turn2Text = "";
      for await (const event of stream2) {
        if (event.type === "text_delta") {
          turn2Text += event.delta;
        }
      }

      const turn2Result = await stream2.result();

      // Must complete cleanly without hanging!
      assert.strictEqual(turn2Result.stopReason, "stop");
      assert.ok(
        turn2Text.toUpperCase().includes("EXECUTION_STARTED"),
        `Expected model response to include EXECUTION_STARTED, got: ${turn2Text}`
      );
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
