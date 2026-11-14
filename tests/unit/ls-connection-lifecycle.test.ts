import { describe, it } from "node:test";
import * as assert from "node:assert";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LsConnection } from "../../src/ls-connection.js";
import { AntigravityClient } from "antigravity-client";

function createFakeLsBinaryScript(dir: string, delayMs = 0): string {
  const scriptPath = path.join(dir, "fake-ls.mjs");
  const script = `#!/usr/bin/env node
setTimeout(() => {
  process.stderr.write("listening on random port at 54321 for HTTPS\\n");
}, ${delayMs});
setInterval(() => {}, 10000);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForProcessExit(pid: number, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return !isProcessAlive(pid);
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
        lsClient: { getUserStatus: async () => ({}) },
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
        lsClient: { getUserStatus: async () => ({}) },
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
        lsClient: { getUserStatus: async () => ({}) },
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

  it("times out hanging reuse candidate via healthCheckTimeoutMs, disposes it, and falls back to standalone spawn (D-01)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    process.env.PI_AGLS_REUSE_LS = "1";

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-reuse-timeout-"));
    const fakeBin = createFakeLsBinaryScript(tmpDir);

    const origList = AntigravityClient.listServers;
    const origConnectWithServer = AntigravityClient.connectWithServer;

    let candidateDisposed = false;
    let observedTimeoutMs: number | undefined;
    let connectCalls = 0;

    AntigravityClient.listServers = async () => [
      {
        pid: 999999,
        httpPort: 0,
        httpsPort: 51112,
        csrfToken: "stale-tok",
        workspaceId: "ws",
        startTime: new Date(),
      },
    ];

    AntigravityClient.connectWithServer = async (server) => {
      connectCalls++;
      if (server.httpsPort === 51112) {
        return {
          lsClient: {
            getUserStatus: (_req: any, opts?: { timeoutMs?: number }) => {
              observedTimeoutMs = opts?.timeoutMs;
              return new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("deadline_exceeded")), opts?.timeoutMs ?? 5000);
              });
            },
          },
          refreshMcpServers: async () => {},
          dispose: () => {
            candidateDisposed = true;
          },
        } as any;
      }
      return {
        lsClient: { getUserStatus: async () => ({}) },
        refreshMcpServers: async () => {},
        dispose: () => {},
      } as any;
    };

    const conn = new LsConnection({
      binaryPath: fakeBin,
      workspacePath: tmpDir,
      healthCheckTimeoutMs: 150,
    });

    try {
      const start = Date.now();
      const client = await conn.ensureClient();
      const elapsed = Date.now() - start;

      assert.ok(client);
      assert.strictEqual(observedTimeoutMs, 150);
      assert.strictEqual(candidateDisposed, true, "Timed-out candidate client must be disposed");
      assert.strictEqual(connectCalls, 2, "Must fall back from timed-out candidate to standalone spawn");
      assert.strictEqual(conn.generation, 1);
      assert.strictEqual(conn.isAlive(), true);
      assert.ok(elapsed < 2000, `Expected fast fallback, took ${elapsed}ms`);
    } finally {
      await conn.stop();
      AntigravityClient.listServers = origList;
      AntigravityClient.connectWithServer = origConnectWithServer;
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      } else {
        delete process.env.PI_AGLS_REUSE_LS;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("SIGKILLs stopped/hung cached lsProcess on probe failure without manual exit/disconnect emit and respawns (D-01, D-02)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    delete process.env.PI_AGLS_REUSE_LS;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-cached-timeout-"));
    const fakeBin = createFakeLsBinaryScript(tmpDir);

    const origConnectWithServer = AntigravityClient.connectWithServer;
    let client1Disposed = false;
    let shouldHangClient1 = false;
    let generationCount = 0;

    AntigravityClient.connectWithServer = async () => {
      generationCount++;
      if (generationCount === 1) {
        return {
          lsClient: {
            getUserStatus: (_req: any, opts?: { timeoutMs?: number }) => {
              if (!shouldHangClient1) return Promise.resolve({});
              return new Promise((_resolve, reject) => {
                setTimeout(() => reject(new Error("deadline_exceeded")), opts?.timeoutMs ?? 5000);
              });
            },
          },
          refreshMcpServers: async () => {},
          dispose: () => {
            client1Disposed = true;
          },
        } as any;
      }
      return {
        lsClient: { getUserStatus: async () => ({}) },
        refreshMcpServers: async () => {},
        dispose: () => {},
      } as any;
    };

    const conn = new LsConnection({
      binaryPath: fakeBin,
      workspacePath: tmpDir,
      healthCheckTimeoutMs: 150,
    });

    let exitEmitted = 0;
    let disconnectEmitted = 0;
    conn.on("exit", () => {
      exitEmitted++;
    });
    conn.on("disconnect", () => {
      disconnectEmitted++;
    });

    try {
      const c1 = await conn.ensureClient();
      assert.ok(c1);
      assert.strictEqual(conn.generation, 1);

      const proc1 = (conn as any).lsProcess;
      assert.ok(proc1 && proc1.pid);
      const pid1 = proc1.pid;

      // Simulate stopped (SIGSTOP -> T state) and unresponsive LS
      process.kill(pid1, "SIGSTOP");
      shouldHangClient1 = true;

      const c2 = await conn.ensureClient();
      assert.ok(c2);
      assert.notStrictEqual(c2, c1);
      assert.strictEqual(client1Disposed, true);
      assert.strictEqual(conn.generation, 2);
      assert.strictEqual(conn.isAlive(), true);
      assert.strictEqual(exitEmitted, 0, "discardClient must not manually emit exit");
      assert.strictEqual(disconnectEmitted, 0, "discardClient must not manually emit disconnect");

      const exited = await waitForProcessExit(pid1, 2000);
      assert.strictEqual(exited, true, `SIGSTOP'd old LS PID ${pid1} must be terminated via SIGKILL`);
    } finally {
      await conn.stop();
      AntigravityClient.connectWithServer = origConnectWithServer;
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("guards concurrent ensureClient() calls against discarding or double-spawning recovered client (D-03)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    delete process.env.PI_AGLS_REUSE_LS;

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-concurrent-"));

    // Subcase A: Caller B's probe rejects AFTER Caller A already completed recovery (C2 established)
    {
      const fakeBin = createFakeLsBinaryScript(tmpDir, 20);
      const origConnectWithServer = AntigravityClient.connectWithServer;
      let connectCount = 0;
      let probeCalls = 0;
      let client2Disposed = false;
      let client2: any = null;

      AntigravityClient.connectWithServer = async () => {
        connectCount++;
        if (connectCount === 1) {
          return {
            lsClient: {
              getUserStatus: () => {
                probeCalls++;
                const delay = probeCalls === 1 ? 20 : 180;
                return new Promise((_resolve, reject) => {
                  setTimeout(() => reject(new Error("deadline_exceeded")), delay);
                });
              },
            },
            refreshMcpServers: async () => {},
            dispose: () => {},
          } as any;
        }
        client2 = {
          lsClient: { getUserStatus: async () => ({}) },
          refreshMcpServers: async () => {},
          dispose: () => {
            client2Disposed = true;
          },
        };
        return client2;
      };

      const conn = new LsConnection({ binaryPath: fakeBin, workspacePath: tmpDir });
      try {
        await conn.ensureClient();
        assert.strictEqual(conn.generation, 1);

        const [resA, resB] = await Promise.all([conn.ensureClient(), conn.ensureClient()]);
        assert.strictEqual(resA, client2);
        assert.strictEqual(resB, client2);
        assert.strictEqual(conn.generation, 2, "Must only respawn once");
        assert.strictEqual(connectCount, 2, "Must not double-spawn a third LS");
        assert.strictEqual(client2Disposed, false, "Recovered client C2 must not be disposed");
      } finally {
        await conn.stop();
        AntigravityClient.connectWithServer = origConnectWithServer;
      }
    }

    // Subcase B: Caller B's probe rejects WHILE Caller A's connectOrLaunch is still in flight
    {
      const slowBinDir = path.join(tmpDir, "slow");
      fs.mkdirSync(slowBinDir, { recursive: true });
      const fakeBinSlow = createFakeLsBinaryScript(slowBinDir, 150);
      const origConnectWithServer = AntigravityClient.connectWithServer;
      let connectCount = 0;
      let probeCalls = 0;
      let client2: any = null;

      AntigravityClient.connectWithServer = async () => {
        connectCount++;
        if (connectCount === 1) {
          return {
            lsClient: {
              getUserStatus: () => {
                probeCalls++;
                const delay = probeCalls === 1 ? 20 : 50;
                return new Promise((_resolve, reject) => {
                  setTimeout(() => reject(new Error("deadline_exceeded")), delay);
                });
              },
            },
            refreshMcpServers: async () => {},
            dispose: () => {},
          } as any;
        }
        client2 = {
          lsClient: { getUserStatus: async () => ({}) },
          refreshMcpServers: async () => {},
          dispose: () => {},
        };
        return client2;
      };

      const conn = new LsConnection({ binaryPath: fakeBinSlow, workspacePath: tmpDir });
      try {
        await conn.ensureClient();
        const [resA, resB] = await Promise.all([conn.ensureClient(), conn.ensureClient()]);
        assert.strictEqual(resA, client2);
        assert.strictEqual(resB, client2);
        assert.strictEqual(conn.generation, 2, "Must coalesce onto A's in-flight connectingPromise");
        assert.strictEqual(connectCount, 2);
      } finally {
        await conn.stop();
        AntigravityClient.connectWithServer = origConnectWithServer;
      }
    }

    if (origEnv !== undefined) {
      process.env.PI_AGLS_REUSE_LS = origEnv;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
