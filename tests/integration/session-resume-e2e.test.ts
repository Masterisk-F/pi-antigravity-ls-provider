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

describe("Live Antigravity LS Process Restart & Session Resume (E2E)", { skip: !HAS_LS_BINARY, timeout: 120000 }, () => {
  it("persists sessions across process restarts, resumes native cascade, executes tools without ghost replay, and rewinds cleanly", async () => {
    const tmpSessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "agls-resume-e2e-"));
    try {
      const modelCatalog = new ModelCatalog();
    const modelDef: any = {
      id: "antigravity-ls/gemini-3.8-flash",
      api: "antigravity-ls",
      provider: "antigravity-ls",
    };

    const sessionA = `sess-resume-a-${Date.now()}`;
    const sessionB = `sess-resume-b-${Date.now()}`;

    const testTools = [
      {
        name: "get_system_status",
        description: "Returns the current cluster status when called",
        parameters: { type: "object", properties: {} },
      },
    ];

    let p1Turn1Reply = "";
    let p1CascadeId = "";

    // ── Phase 1: Process 1 Execution ──
    {
      const bindingStore = new BindingStore(tmpSessionsDir);
      const roundTrip = new RoundTrip();
      const mcpServer = new McpBridgeServer({
        toolsProvider: () => testTools as any,
        roundTrip,
        instanceId: `p1-${process.pid}`,
      });
      await mcpServer.start();

      const lsConnection = new LsConnection({ workspacePath: process.cwd(), mcpServer });
      const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
      const streamSimple = createStreamSimple({ lsConnection, cascadeManager, roundTrip, modelCatalog, mcpServer });

      // Session A - Turn 1
      const s1 = streamSimple(modelDef, {
        messages: [{ id: "m1", role: "user", content: "Remember the secret code: COSMOS-42. Reply only OK." }],
      } as any, { sessionId: sessionA });

      for await (const ev of s1) {
        if (ev.type === "text_delta") p1Turn1Reply += ev.delta;
      }
      const r1 = await s1.result();
      assert.strictEqual(r1.stopReason, "stop");
      assert.ok(p1Turn1Reply.length > 0);

      const bindingA = bindingStore.get(sessionA);
      assert.ok(bindingA?.cascadeId, "Session A must have a cascadeId");
      p1CascadeId = bindingA!.cascadeId;

      // Session B - Turn 1 (Verify per-session isolation)
      const sB = streamSimple(modelDef, {
        messages: [{ id: "mb1", role: "user", content: "Say hello from session B." }],
      } as any, { sessionId: sessionB });
      for await (const _ of sB) {}
      await sB.result();

      const bindingB = bindingStore.get(sessionB);
      assert.ok(bindingB?.cascadeId, "Session B must have its own cascadeId");
      assert.notStrictEqual(bindingB?.cascadeId, p1CascadeId, "Session A and B must have distinct cascadeIds");

      // Verify files on disk
      assert.ok(fs.existsSync(bindingStore.getSessionFilePath(sessionA)));
      assert.ok(fs.existsSync(bindingStore.getSessionFilePath(sessionB)));

      // Teardown Process 1 using disposeAll (D-01)
      cascadeManager.disposeAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }

    // ── Phase 2: Process 2 Execution (Restart, Resume Session A, Execute Tool, No Ghost Replay) ──
    {
      const bindingStore = new BindingStore(tmpSessionsDir);
      // Session B must still exist on disk unaffected!
      assert.ok(bindingStore.get(sessionB)?.cascadeId, "Session B binding must survive Process 1 shutdown");

      const roundTrip = new RoundTrip();
      const mcpServer = new McpBridgeServer({
        toolsProvider: () => testTools as any,
        roundTrip,
        instanceId: `p2-${process.pid}`,
      });
      await mcpServer.start();

      const lsConnection = new LsConnection({ workspacePath: process.cwd(), mcpServer });
      const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
      const streamSimple = createStreamSimple({ lsConnection, cascadeManager, roundTrip, modelCatalog, mcpServer });

      // Session A continuation with mid-conversation system patch (D-04)
      const contextMessages: any[] = [
        { id: "m1", role: "user", content: "Remember the secret code: COSMOS-42. Reply only OK.", timestamp: 1000 },
        { id: "m2", role: "assistant", content: [{ type: "text", text: p1Turn1Reply }], provider: "antigravity-ls", timestamp: 2000 },
        { role: "system", content: "", sections: { context: "System operating normal." }, timestamp: 2500 },
        { id: "m3", role: "user", content: "Call the get_system_status tool, then tell me both the secret code from earlier and the status.", timestamp: 3000 },
      ];

      // Turn 2a: Tool execution
      const s2a = streamSimple(modelDef, { messages: contextMessages } as any, { sessionId: sessionA });
      let toolCall: any = null;
      for await (const ev of s2a) {
        if (ev.type === "toolcall_end") toolCall = ev.toolCall;
      }
      const r2a = await s2a.result();

      assert.strictEqual(r2a.stopReason, "toolUse");
      assert.ok(toolCall, "Model must call get_system_status");
      assert.strictEqual(toolCall.name, "get_system_status");

      // Verify resumed cascade ID
      const bindingAfterResume = bindingStore.get(sessionA);
      assert.strictEqual(bindingAfterResume?.cascadeId, p1CascadeId, "Must resume same Cascade without starting a new one");
      assert.strictEqual(bindingAfterResume?.priorHistory, "", "priorHistory must be empty for native resume");

      // Resolve parked tool call via roundTrip
      roundTrip.resolve(toolCall.id, {
        content: [{ type: "text", text: "CLUSTER_STATUS_HEALTHY_99" }],
      });

      // Turn 2b: Tool continuation
      const continuationMessages = [
        ...contextMessages,
        r2a,
        {
          id: "m4",
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "CLUSTER_STATUS_HEALTHY_99" }],
          timestamp: 3500,
        },
      ];

      const s2b = streamSimple(modelDef, { messages: continuationMessages } as any, { sessionId: sessionA });
      let finalReply = "";
      for await (const ev of s2b) {
        if (ev.type === "text_delta") finalReply += ev.delta;
      }
      const r2b = await s2b.result();
      assert.strictEqual(r2b.stopReason, "stop");

      console.log("Process 2 Turn 2 final reply:", finalReply);

      // Verify no Ghost Replay (D-02): Turn 1 reply ("OK") must NOT be prefixed/replayed into Turn 2 output
      const trimmedReply = finalReply.trim();
      assert.strictEqual(
        trimmedReply.startsWith("OKOK") || trimmedReply.startsWith(p1Turn1Reply + p1Turn1Reply),
        false,
        `Turn 2 output must not contain duplicated ghost reply: ${finalReply}`
      );
      assert.ok(
        finalReply.includes("COSMOS-42"),
        `Model must remember code word COSMOS-42 across restart, got: ${finalReply}`
      );
      assert.ok(
        finalReply.includes("CLUSTER_STATUS_HEALTHY_99") || finalReply.includes("HEALTHY"),
        `Model must include tool output, got: ${finalReply}`
      );

      // Teardown Process 2
      cascadeManager.disposeAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }

    // ── Phase 3: Process 3 Execution (Restart and Rewind across process restart) ──
    {
      const bindingStore = new BindingStore(tmpSessionsDir);
      const roundTrip = new RoundTrip();
      const mcpServer = new McpBridgeServer({
        toolsProvider: () => testTools as any,
        roundTrip,
        instanceId: `p3-${process.pid}`,
      });
      await mcpServer.start();

      const lsConnection = new LsConnection({ workspacePath: process.cwd(), mcpServer });
      const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
      const streamSimple = createStreamSimple({ lsConnection, cascadeManager, roundTrip, modelCatalog, mcpServer });

      // Rewind back to Turn 1 (dropping Turn 2 tool calls and responses)
      const rewoundMessages: any[] = [
        { id: "m1", role: "user", content: "Remember the secret code: COSMOS-42. Reply only OK.", timestamp: 1000 },
        { id: "m2", role: "assistant", content: [{ type: "text", text: p1Turn1Reply }], provider: "antigravity-ls", timestamp: 2000 },
        { id: "m5", role: "user", content: "What was the secret code I gave you? Answer with only the code.", timestamp: 4000 },
      ];

      const s3 = streamSimple(modelDef, { messages: rewoundMessages } as any, { sessionId: sessionA });
      let rewindReply = "";
      for await (const ev of s3) {
        if (ev.type === "text_delta") rewindReply += ev.delta;
      }
      const r3 = await s3.result();
      assert.strictEqual(r3.stopReason, "stop");
      console.log("Process 3 Rewind reply:", rewindReply);

      assert.ok(
        rewindReply.includes("COSMOS-42"),
        `Model must remember COSMOS-42 after rewind across restarts, got: ${rewindReply}`
      );

      // Clean up all bindings for temporary test directory
      cascadeManager.clearAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
    } finally {
      try {
        if (fs.existsSync(tmpSessionsDir)) {
          fs.rmSync(tmpSessionsDir, { recursive: true, force: true });
        }
      } catch {
        // ignore
      }
    }
  });
});
