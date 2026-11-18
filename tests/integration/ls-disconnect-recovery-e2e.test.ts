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

describe("Live Antigravity LS Disconnect & Recovery (E2E)", { skip: !HAS_LS_BINARY, timeout: 120000 }, () => {
  it("recovers seamlessly from SIGKILL of active LS without 120s timeout and preserves context (D-01, D-02, D-03, D-04)", async () => {
    const modelCatalog = new ModelCatalog();
    const bindingStore = BindingStore.inMemory();
    const roundTrip = new RoundTrip();
    const mcpServer = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip,
      instanceId: `e2e-disc-${process.pid}`,
    });
    await mcpServer.start();

    const lsConnection = new LsConnection({
      workspacePath: process.cwd(),
      mcpServer,
    });
    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
    const streamSimple = createStreamSimple({
      lsConnection,
      cascadeManager,
      roundTrip,
      modelCatalog,
      mcpServer,
    });

    const modelDef: any = {
      id: "antigravity-ls/gemini-3.8-flash",
      api: "antigravity-ls",
      provider: "antigravity-ls",
    };
    const sessionId = `sess-disc-e2e-${Date.now()}`;

    try {
      // ── Turn 1: Establish conversation on Generation 1 LS ──
      const msg1: any = {
        id: "m1",
        role: "user",
        content: "Remember the secret code: NEBULA-99. Reply only OK.",
        timestamp: Date.now(),
      };
      const s1 = streamSimple(modelDef, { messages: [msg1] } as any, { sessionId });

      let turn1Text = "";
      for await (const ev of s1) {
        if (ev.type === "text_delta") turn1Text += ev.delta;
      }
      const r1 = await s1.result();
      assert.strictEqual(r1.stopReason, "stop");
      assert.ok(turn1Text.length > 0);
      assert.strictEqual(lsConnection.generation, 1);
      assert.strictEqual(lsConnection.isAlive(), true);

      // ── Simulate abrupt LS death (kill -9, equivalent to GUI closing) ──
      const proc = (lsConnection as any).lsProcess;
      assert.ok(proc && proc.pid, "Dedicated standalone LS process must exist");
      const exitPromise = new Promise<void>((resolve) => {
        lsConnection.once("exit", () => resolve());
      });
      process.kill(proc.pid, "SIGKILL");
      await exitPromise;
      assert.strictEqual(lsConnection.isAlive(), false);

      // ── Turn 2: Continue conversation on auto-restarted Generation 2 LS ──
      const msg2: any = {
        id: "m2",
        role: "user",
        content: "What was the secret code I just told you? Reply with the code only.",
        timestamp: Date.now(),
      };

      const startTurn2 = Date.now();
      const s2 = streamSimple(
        modelDef,
        { messages: [msg1, r1, msg2] } as any,
        { sessionId }
      );

      let turn2Text = "";
      for await (const ev of s2) {
        if (ev.type === "text_delta") turn2Text += ev.delta;
      }
      const r2 = await s2.result();
      const turn2Duration = Date.now() - startTurn2;

      assert.strictEqual(r2.stopReason, "stop", `Turn 2 failed: ${r2.errorMessage}`);
      assert.ok(
        turn2Duration < 45000,
        `Turn 2 should recover quickly without 120s timeout, took ${turn2Duration}ms`
      );
      assert.strictEqual(lsConnection.generation, 2);
      assert.strictEqual(lsConnection.isAlive(), true);
      assert.ok(
        turn2Text.includes("NEBULA-99"),
        `Turn 2 must remember NEBULA-99 across LS restart, got: ${turn2Text}`
      );
    } finally {
      cascadeManager.disposeAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });

  it("recovers from SIGSTOP (T state) of active LS via healthCheckTimeoutMs, SIGKILLs old PID, and preserves context", async () => {
    const modelCatalog = new ModelCatalog();
    const bindingStore = BindingStore.inMemory();
    const roundTrip = new RoundTrip();
    const mcpServer = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip,
      instanceId: `e2e-sigstop-${process.pid}`,
    });
    await mcpServer.start();

    const lsConnection = new LsConnection({
      workspacePath: process.cwd(),
      mcpServer,
      healthCheckTimeoutMs: 2000,
    });
    const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
    const streamSimple = createStreamSimple({
      lsConnection,
      cascadeManager,
      roundTrip,
      modelCatalog,
      mcpServer,
    });

    const modelDef: any = {
      id: "antigravity-ls/gemini-3.8-flash",
      api: "antigravity-ls",
      provider: "antigravity-ls",
    };
    const sessionId = `sess-sigstop-e2e-${Date.now()}`;
    let oldPid: number | undefined;

    try {
      // ── Turn 1: Establish conversation on Generation 1 LS ──
      const msg1: any = {
        id: "m1",
        role: "user",
        content: "Remember the secret code: NEBULA-99. Reply only OK.",
        timestamp: Date.now(),
      };
      const s1 = streamSimple(modelDef, { messages: [msg1] } as any, { sessionId });

      let turn1Text = "";
      for await (const ev of s1) {
        if (ev.type === "text_delta") turn1Text += ev.delta;
      }
      const r1 = await s1.result();
      assert.strictEqual(r1.stopReason, "stop");
      assert.ok(turn1Text.length > 0);
      assert.strictEqual(lsConnection.generation, 1);
      assert.strictEqual(lsConnection.isAlive(), true);

      // ── Simulate Ctrl+Z / SIGSTOP (T state: process exists, TCP ESTAB works, RPC hangs) ──
      const proc = (lsConnection as any).lsProcess;
      assert.ok(proc && proc.pid, "Dedicated standalone LS process must exist");
      const stoppedPid: number = proc.pid;
      oldPid = stoppedPid;
      process.kill(stoppedPid, "SIGSTOP");

      // ── Turn 2: ensureClient() probe times out, SIGKILLs oldPid, and spawns Generation 2 LS ──
      const msg2: any = {
        id: "m2",
        role: "user",
        content: "What was the secret code I just told you? Reply with the code only.",
        timestamp: Date.now(),
      };

      const startTurn2 = Date.now();
      const s2 = streamSimple(
        modelDef,
        { messages: [msg1, r1, msg2] } as any,
        { sessionId }
      );

      let turn2Text = "";
      for await (const ev of s2) {
        if (ev.type === "text_delta") turn2Text += ev.delta;
      }
      const r2 = await s2.result();
      const turn2Duration = Date.now() - startTurn2;

      assert.strictEqual(r2.stopReason, "stop", `Turn 2 failed: ${r2.errorMessage}`);
      assert.ok(
        turn2Duration < 45000,
        `Turn 2 should recover quickly without 120s timeout, took ${turn2Duration}ms`
      );
      assert.strictEqual(lsConnection.generation, 2);
      assert.strictEqual(lsConnection.isAlive(), true);
      assert.ok(
        turn2Text.includes("NEBULA-99"),
        `Turn 2 must remember NEBULA-99 across SIGSTOP recovery, got: ${turn2Text}`
      );

      // Verify old SIGSTOP'd PID was killed via SIGKILL
      const deadline = Date.now() + 2000;
      let oldAlive = true;
      while (Date.now() < deadline) {
        try {
          process.kill(oldPid!, 0);
          await new Promise((r) => setTimeout(r, 25));
        } catch {
          oldAlive = false;
          break;
        }
      }
      assert.strictEqual(oldAlive, false, `Old SIGSTOP'd LS PID ${oldPid} must be dead`);
    } finally {
      if (oldPid) {
        try {
          process.kill(oldPid, "SIGKILL");
        } catch {
          // ignore if already dead
        }
      }
      cascadeManager.disposeAll();
      await mcpServer.stop();
      await lsConnection.stop();
    }
  });
});
