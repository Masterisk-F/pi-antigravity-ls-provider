import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LsConnection } from "../../src/ls-connection.js";
import { AntigravityClient } from "antigravity-client";

function createFakeLsBinaryScript(dir: string): string {
  const scriptPath = path.join(dir, "fake-ls.mjs");
  const script = `#!/usr/bin/env node
process.stderr.write("listening on random port at 54321 for HTTPS\\n");
setInterval(() => {}, 10000);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("LsConnection Lifecycle & Non-Shared Isolation (Unit)", () => {
  it("initializes with generation 0 and is an EventEmitter", () => {
    const conn = new LsConnection();
    assert.strictEqual(conn.generation, 0);
    assert.strictEqual(conn.isAlive(), false);
    assert.ok(conn instanceof EventEmitter);
  });

  it("skips listServers() by default when PI_AGLS_REUSE_LS is unset and spawns standalone LS (D-01)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    delete process.env.PI_AGLS_REUSE_LS;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-test-"));
    const fakeBin = createFakeLsBinaryScript(tmpDir);

    let listServersCalled = false;
    const origList = AntigravityClient.listServers;
    const origConnectWithServer = AntigravityClient.connectWithServer;

    AntigravityClient.listServers = async () => {
      listServersCalled = true;
      return [];
    };
    AntigravityClient.connectWithServer = async () =>
      ({
        getUserStatus: async () => ({}),
        refreshMcpServers: async () => {},
        dispose: () => {},
      }) as any;

    const conn = new LsConnection({ binaryPath: fakeBin, workspacePath: tmpDir });
    try {
      const client = await conn.ensureClient();
      assert.ok(client);
      assert.strictEqual(
        listServersCalled,
        false,
        "AntigravityClient.listServers() must NOT be called when PI_AGLS_REUSE_LS is not '1'"
      );
      assert.strictEqual(conn.generation, 1);
      assert.strictEqual(conn.isAlive(), true);
    } finally {
      await conn.stop();
      AntigravityClient.listServers = origList;
      AntigravityClient.connectWithServer = origConnectWithServer;
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("calls listServers() when PI_AGLS_REUSE_LS=1 is explicitly set (D-01)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    process.env.PI_AGLS_REUSE_LS = "1";

    let listServersCalled = false;
    const origList = AntigravityClient.listServers;
    const origConnectWithServer = AntigravityClient.connectWithServer;

    AntigravityClient.listServers = async () => {
      listServersCalled = true;
      return [
        {
          pid: process.pid,
          httpPort: 0,
          httpsPort: 51111,
          csrfToken: "tok",
          workspaceId: "ws",
          startTime: new Date(),
        },
      ];
    };
    AntigravityClient.connectWithServer = async () =>
      ({
        getUserStatus: async () => ({}),
        refreshMcpServers: async () => {},
        dispose: () => {},
      }) as any;

    const conn = new LsConnection();
    try {
      await conn.ensureClient();
      assert.strictEqual(
        listServersCalled,
        true,
        "AntigravityClient.listServers() must be called when PI_AGLS_REUSE_LS is '1'"
      );
      assert.strictEqual(conn.generation, 1);
    } finally {
      await conn.stop();
      AntigravityClient.listServers = origList;
      AntigravityClient.connectWithServer = origConnectWithServer;
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      } else {
        delete process.env.PI_AGLS_REUSE_LS;
      }
    }
  });

  it("emits exit/disconnect when spawned LS dies unexpectedly and increments generation on reconnect (D-02, D-04)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    delete process.env.PI_AGLS_REUSE_LS;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-crash-"));
    const fakeBin = createFakeLsBinaryScript(tmpDir);

    const origConnectWithServer = AntigravityClient.connectWithServer;
    AntigravityClient.connectWithServer = async () =>
      ({
        getUserStatus: async () => ({}),
        refreshMcpServers: async () => {},
        dispose: () => {},
      }) as any;

    const conn = new LsConnection({ binaryPath: fakeBin, workspacePath: tmpDir });

    try {
      await conn.ensureClient();
      assert.strictEqual(conn.generation, 1);
      assert.strictEqual(conn.isAlive(), true);

      const exitPromise = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
        conn.once("exit", resolve);
      });
      let disconnectEmitted = false;
      conn.once("disconnect", () => {
        disconnectEmitted = true;
      });

      // Kill the underlying child process to simulate unexpected LS crash / termination
      const proc = (conn as any).lsProcess;
      assert.ok(proc && proc.pid);
      process.kill(proc.pid, "SIGKILL");

      const exitInfo = await exitPromise;
      assert.strictEqual(exitInfo.signal, "SIGKILL");
      assert.strictEqual(disconnectEmitted, true);
      assert.strictEqual(conn.isAlive(), false);

      // Reconnecting must spawn a new LS and increment generation to 2
      await conn.ensureClient();
      assert.strictEqual(conn.generation, 2);
      assert.strictEqual(conn.isAlive(), true);
    } finally {
      await conn.stop();
      AntigravityClient.connectWithServer = origConnectWithServer;
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
