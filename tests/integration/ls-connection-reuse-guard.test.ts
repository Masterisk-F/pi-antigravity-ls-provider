import { describe, it } from "node:test";
import * as assert from "node:assert";
import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AntigravityClient } from "antigravity-client";
import { LsConnection } from "../../src/ls-connection.js";

function createFakeLsBinaryScript(dir: string): string {
  const scriptPath = path.join(dir, "fake-ls.mjs");
  const script = `#!/usr/bin/env node
process.stderr.write("listening on random port at 54322 for HTTPS\\n");
setInterval(() => {}, 10000);
`;
  fs.writeFileSync(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

describe("LsConnection Real ConnectRPC Timeout Against SIGSTOP'd Server (Integration)", () => {
  it("cancels real ConnectRPC getUserStatus against a SIGSTOP'd TCP listener within healthCheckTimeoutMs and spawns standalone LS (D-01)", async () => {
    const origEnv = process.env.PI_AGLS_REUSE_LS;
    process.env.PI_AGLS_REUSE_LS = "1";

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ls-conn-int-"));
    const fakeBin = createFakeLsBinaryScript(tmpDir);
    const origList = AntigravityClient.listServers;

    // Spawn a real TCP listener process and SIGSTOP it so TCP 3-way handshake succeeds
    // in kernel space while user-space RPC response is never sent.
    const stoppedServer: ChildProcess = spawn(
      process.execPath,
      [
        "-e",
        `const net = require("net");
         const s = net.createServer(() => {});
         s.listen(0, "127.0.0.1", () => process.stdout.write(String(s.address().port) + "\\n"));`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] }
    );

    const stoppedPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Timed out waiting for test listener port")), 5000);
      stoppedServer.stdout!.once("data", (chunk: Buffer) => {
        clearTimeout(timer);
        resolve(parseInt(chunk.toString().trim(), 10));
      });
      stoppedServer.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });

    assert.ok(stoppedServer.pid);
    process.kill(stoppedServer.pid, "SIGSTOP");

    AntigravityClient.listServers = async () => [
      {
        pid: stoppedServer.pid!,
        httpPort: 0,
        httpsPort: stoppedPort,
        csrfToken: "stopped-csrf",
        workspaceId: "stopped-ws",
        startTime: new Date(),
      },
    ];

    const conn = new LsConnection({
      binaryPath: fakeBin,
      workspacePath: tmpDir,
      healthCheckTimeoutMs: 300,
    });

    try {
      const start = Date.now();
      const client = await conn.ensureClient();
      const elapsed = Date.now() - start;

      assert.ok(client);
      assert.strictEqual(conn.generation, 1);
      assert.strictEqual(conn.isAlive(), true);
      assert.ok(elapsed < 5000, `Expected real ConnectRPC timeout fallback under 5s, took ${elapsed}ms`);
    } finally {
      await conn.stop();
      AntigravityClient.listServers = origList;
      if (stoppedServer.pid) {
        try {
          process.kill(stoppedServer.pid, "SIGKILL");
        } catch {
          // ignore
        }
      }
      if (origEnv !== undefined) {
        process.env.PI_AGLS_REUSE_LS = origEnv;
      } else {
        delete process.env.PI_AGLS_REUSE_LS;
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
