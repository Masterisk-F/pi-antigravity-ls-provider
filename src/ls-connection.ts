/**
 * LS Connection Manager
 *
 * Launches and connects to Antigravity Language Server with authentic Antigravity IDE flags,
 * enabling Gemini 3.8 Flash and the full production model suite.
 */

import { AntigravityClient, type ServerInfo } from "antigravity-client";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";

export interface LsConnectionOptions {
  workspacePath?: string;
  verbose?: boolean;
}

const DEFAULT_LS_BINARY = "/opt/Antigravity/resources/bin/language_server";

export class LsConnection {
  private client: AntigravityClient | null = null;
  private lsProcess: ChildProcess | null = null;
  private connectingPromise: Promise<AntigravityClient> | null = null;
  private workspacePath: string;
  private verbose: boolean;

  constructor(options: LsConnectionOptions = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    this.verbose = options.verbose ?? false;
  }

  setWorkspacePath(wsPath: string) {
    this.workspacePath = wsPath;
  }

  async ensureClient(): Promise<AntigravityClient> {
    if (this.client) {
      try {
        await this.client.getUserStatus();
        return this.client;
      } catch {
        this.client = null;
      }
    }

    if (this.connectingPromise) {
      return this.connectingPromise;
    }

    this.connectingPromise = this.connectOrLaunch().finally(() => {
      this.connectingPromise = null;
    });

    return this.connectingPromise;
  }

  private async connectOrLaunch(): Promise<AntigravityClient> {
    // 1. Check for any running Antigravity LS
    try {
      const servers = await AntigravityClient.listServers();
      if (servers.length > 0) {
        const target = servers[0];
        const client = await AntigravityClient.connectWithServer(target);
        await client.getUserStatus();
        if (this.verbose) {
          console.error(`[LsConnection] Reusing running LS PID ${target.pid}`);
        }
        this.client = client;
        return client;
      }
    } catch {
      // ignore
    }

    // 2. Launch LS with authentic Antigravity IDE flags
    if (this.verbose) {
      console.error(`[LsConnection] Spawning authentic Antigravity LS for ${this.workspacePath}`);
    }

    const binary = fs.existsSync(DEFAULT_LS_BINARY)
      ? DEFAULT_LS_BINARY
      : (process.env.CODEIUM_LANGUAGE_SERVER_BIN || "language_server");

    const csrfToken = crypto.randomUUID();

    const args = [
      "--standalone",
      "--override_ide_name", "antigravity",
      "--subclient_type", "hub",
      "--override_ide_version", "1.107.0",
      "--override_user_agent_name", "antigravity",
      "--https_server_port", "0",
      "--http_server_port", "0",
      "--lsp_port", "0",
      "--csrf_token", csrfToken,
      "--app_data_dir", "antigravity",
      "--api_server_url", "https://generativelanguage.googleapis.com",
      "--cloud_code_endpoint", "https://daily-cloudcode-pa.googleapis.com",
      "--enable_sidecars",
    ];

    const proc = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    // Close stdin so LS starts normal event loop
    proc.stdin.end();

    // Prevent child process from blocking Node.js exit in one-shot mode
    try {
      proc.unref();
    } catch {
      // ignore
    }

    this.lsProcess = proc;

    proc.on("exit", (code, signal) => {
      if (this.verbose) {
        console.error(`[LsConnection] LS exited (code=${code}, signal=${signal})`);
      }
      this.client = null;
      this.lsProcess = null;
    });

    // Wait for the HTTPS port line
    const httpsPort = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error("Timeout waiting for Antigravity LS HTTPS port"));
      }, 30000);

      let resolved = false;

      proc.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        const m = text.match(/listening on random port at (\d+) for HTTPS/i);
        if (m && !resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(parseInt(m[1], 10));
        }
      });

      proc.on("error", (err) => {
        if (!resolved) {
          clearTimeout(timer);
          reject(err);
        }
      });
    });

    if (this.verbose) {
      console.error(`[LsConnection] Authentic LS ready on HTTPS port ${httpsPort}`);
    }

    const serverInfo: ServerInfo = {
      pid: proc.pid ?? 0,
      httpPort: 0,
      httpsPort,
      csrfToken,
      workspaceId: `antigravity-ls-${path.basename(this.workspacePath)}`,
      startTime: new Date(),
    };

    const client = await AntigravityClient.connectWithServer(serverInfo);
    this.client = client;
    return client;
  }

  getClient(): AntigravityClient | null {
    return this.client;
  }

  async stop(): Promise<void> {
    if (this.client) {
      try {
        this.client.dispose();
      } catch {
        // ignore
      }
      this.client = null;
    }

    if (this.lsProcess && !this.lsProcess.killed) {
      try {
        this.lsProcess.kill("SIGTERM");
      } catch {
        // ignore
      }
      this.lsProcess = null;
    }
  }
}
