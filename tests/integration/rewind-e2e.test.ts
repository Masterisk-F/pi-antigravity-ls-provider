import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LsConnection } from "../../src/ls-connection.js";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";
import { createStreamSimple } from "../../src/provider-stream.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";

describe("Live Antigravity LS Rewind Accuracy & Stability (E2E)", { timeout: 90000 }, () => {
  it("accurately rewinds to Turn 1 so model forgets Turn 2 and answers without error or hang", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-e2e-rewind-"));
    const bindingStore = new BindingStore(path.join(tmpDir, "bindings.json"));
    const roundTrip = new RoundTrip();

    const mcpServer = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip,
      verbose: false,
    });
    await mcpServer.start();

    const lsConnection = new LsConnection({
      workspacePath: process.cwd(),
      mcpServer,
      verbose: false,
    });

    const modelCatalog = new ModelCatalog();
    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);

    const streamSimple = createStreamSimple({
      lsConnection,
      cascadeManager,
      roundTrip,
      modelCatalog,
      mcpServer,
      verbose: false,
    });

    const modelDef: any = {
      id: "antigravity-ls/gemini-4-argon",
      api: "antigravity-ls",
      provider: "antigravity-ls",
    };

    const sessionId = `e2e-rewind-${Date.now()}`;

    // ── Turn 1 ──
    const turn1Stream = streamSimple(modelDef, {
      messages: [{ id: "turn-1-user", role: "user", content: "Remember the code word: APPLE. Reply only with OK." }],
    } as any, { sessionId });

    let turn1Text = "";
    for await (const event of turn1Stream) {
      if (event.type === "text_delta") turn1Text += event.delta;
    }
    const turn1Res = await turn1Stream.result();
    assert.strictEqual(turn1Res.stopReason, "stop");
    assert.ok(turn1Text.length > 0, "Turn 1 must produce a non-empty response");

    // ── Turn 2 ──
    const turn2Stream = streamSimple(modelDef, {
      messages: [
        { id: "turn-1-user", role: "user", content: "Remember the code word: APPLE. Reply only with OK." },
        { id: "turn-1-asst", role: "assistant", content: [{ type: "text", text: turn1Text }], provider: "antigravity-ls" },
        { id: "turn-2-user", role: "user", content: "Forget APPLE. The new code word is BANANA. Reply only with OK." },
      ],
    } as any, { sessionId });

    let turn2Text = "";
    for await (const event of turn2Stream) {
      if (event.type === "text_delta") turn2Text += event.delta;
    }
    const turn2Res = await turn2Stream.result();
    assert.strictEqual(turn2Res.stopReason, "stop");
    assert.ok(turn2Text.length > 0, "Turn 2 must produce a non-empty response");

    // ── Rewind to Turn 1 ──
    // Turn 2 is completely removed from the branch, as happens when navigating via /rewind.
    // Turn 3 asks for the code word.
    const turn3Stream = streamSimple(modelDef, {
      messages: [
        { id: "turn-1-user", role: "user", content: "Remember the code word: APPLE. Reply only with OK." },
        { id: "turn-1-asst", role: "assistant", content: [{ type: "text", text: turn1Text }], provider: "antigravity-ls" },
        { id: "turn-3-user", role: "user", content: "What was the first code word I told you to remember? Name only the word." },
      ],
    } as any, { sessionId });

    try {
      let turn3Text = "";
      for await (const event of turn3Stream) {
        if (event.type === "text_delta") turn3Text += event.delta;
      }
      const turn3Res = await turn3Stream.result();
      assert.strictEqual(turn3Res.stopReason, "stop", "Turn 3 must complete cleanly with stop (no error, no hang)");

      console.log("Turn 3 response after rewind:", turn3Text);

      // Because Turn 2 (BANANA) was rewound out of the trajectory, the model must remember APPLE, NOT BANANA.
      assert.ok(
        turn3Text.toUpperCase().includes("APPLE"),
        `Model must remember APPLE after rewind to Turn 1, received: ${turn3Text}`
      );
      assert.strictEqual(
        turn3Text.toUpperCase().includes("BANANA"),
        false,
        `Model must NOT remember BANANA after rewind, received: ${turn3Text}`
      );
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });

  it("rewinds to intermediate toolResult in multi-tool turn so model forgets second tool result (Section 6.2c)", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-e2e-midtool-"));
    const bindingStore = new BindingStore(path.join(tmpDir, "bindings.json"));
    const roundTrip = new RoundTrip();

    const mockTools = [
      {
        name: "read",
        description: "Read a file",
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
      verbose: false,
    });
    await mcpServer.start();

    const lsConnection = new LsConnection({
      workspacePath: process.cwd(),
      mcpServer,
      verbose: false,
    });

    const modelCatalog = new ModelCatalog();
    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);

    const streamSimple = createStreamSimple({
      lsConnection,
      cascadeManager,
      roundTrip,
      modelCatalog,
      mcpServer,
      verbose: false,
    });

    const modelDef: any = {
      id: "antigravity-ls/gemini-3.8-flash",
      api: "antigravity-ls",
      provider: "antigravity-ls",
    };

    const sessionId = `e2e-midtool-${Date.now()}`;

    // Tool execution handler
    roundTrip.on("park", (p) => {
      const filePath = p.args?.path;
      const contentText = filePath === "alpha.txt" ? "CODE_ALPHA=111" : "CODE_BETA=222";
      setTimeout(() => {
        roundTrip.resolve(p.callId, {
          content: [{ type: "text", text: contentText }],
        });
      }, 50);
    });

    try {
      // ── Turn 1: user requests two tool calls in sequence ──
      const turn1Context: any = {
        messages: [
          {
            id: "msg-user-1",
            role: "user",
            content: "First call read on alpha.txt, then call read on beta.txt, then report both code words.",
          },
        ],
      };

      // Loop sub-turns until stopReason is stop
      let isTurn1Done = false;
      let lastAsstResult: any = null;
      let subturnCount = 0;

      while (!isTurn1Done && subturnCount < 5) {
        subturnCount++;
        const stream = streamSimple(modelDef, turn1Context, { sessionId });
        for await (const _ of stream) {}
        lastAsstResult = await stream.result();

        if (lastAsstResult.stopReason === "toolUse") {
          // Find the toolCall
          const toolCall = lastAsstResult.content.find((b: any) => b.type === "toolCall");
          turn1Context.messages.push(lastAsstResult);
          turn1Context.messages.push({
            id: `msg-tr-${toolCall.id}`,
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: toolCall.arguments?.path === "alpha.txt" ? "CODE_ALPHA=111" : "CODE_BETA=222" }],
          });
        } else {
          turn1Context.messages.push(lastAsstResult);
          isTurn1Done = true;
        }
      }

      assert.strictEqual(isTurn1Done, true, "Turn 1 must complete successfully");
      assert.ok(subturnCount >= 2, "Turn 1 must execute multiple tool calls");

      // Verify that toolResult for alpha.txt exists in turn1Context
      const tr1Message = turn1Context.messages.find(
        (m: any) => m.role === "toolResult" && m.content?.[0]?.text?.includes("CODE_ALPHA")
      );
      assert.ok(tr1Message, "First toolResult (CODE_ALPHA) must exist in conversation");

      // ── Rewind via /tree: user branches back to TR1 (after alpha.txt, before beta.txt) ──
      const tr1Index = turn1Context.messages.indexOf(tr1Message);
      const rewoundBranch = [
        ...turn1Context.messages.slice(0, tr1Index + 1),
        {
          id: "msg-user-rewound",
          role: "user",
          content: "Do not call any tools. What secret values have you read from files? Reply with only the secrets you have observed.",
        },
      ];

      const turn2Stream = streamSimple(modelDef, { messages: rewoundBranch } as any, { sessionId });
      let turn2Text = "";
      for await (const event of turn2Stream) {
        if (event.type === "text_delta") turn2Text += event.delta;
      }
      const turn2Res = await turn2Stream.result();

      assert.strictEqual(turn2Res.stopReason, "stop", "Turn 2 after rewind must complete cleanly with stop");
      console.log("Turn 2 text after rewind to intermediate toolResult:", turn2Text);

      // Model should know CODE_ALPHA / 111 (from tool 1), but NOT 222 (tool 2 was rewound out)
      assert.ok(
        turn2Text.includes("111") || turn2Text.toUpperCase().includes("CODE_ALPHA"),
        `Model must remember CODE_ALPHA / 111 from tool 1, got: ${turn2Text}`
      );
      assert.strictEqual(
        turn2Text.includes("222"),
        false,
        `Model must NOT know 222 after rollback to tool 1, got: ${turn2Text}`
      );

      // Verify actual LS trajectory steps
      const client = await lsConnection.ensureClient();
      const binding = bindingStore.get(sessionId)!;
      const hist = await client.lsClient.getCascadeTrajectory({ cascadeId: binding.cascadeId });
      const steps = hist.trajectory?.steps || [];

      // Trajectory must have:
      // step 0: userInput (turn 1 prompt)
      // step 1: plannerResponse (read alpha.txt)
      // step 2: generic (toolResult alpha.txt)
      // step 3: userInput (turn 2 prompt)
      // step 4: plannerResponse (turn 2 answer)
      assert.strictEqual(steps[0].type, 14, "Step 0 must be userInput");
      assert.strictEqual(steps[1].type, 15, "Step 1 must be plannerResponse");
      assert.strictEqual(steps[2].type, 132, "Step 2 must be generic toolResult");
      assert.strictEqual(steps[3].type, 14, "Step 3 must be userInput (turn 2 prompt after rewind)");
      assert.strictEqual(steps[4].type, 15, "Step 4 must be plannerResponse (turn 2 answer)");
    } finally {
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
