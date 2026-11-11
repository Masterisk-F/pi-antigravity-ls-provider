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
});
