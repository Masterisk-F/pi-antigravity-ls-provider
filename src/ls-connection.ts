/**
 * LS Connection Manager
 *
 * Connects to the authentic Antigravity Language Server (or launches it if not running).
 * Synchronizes instance-unique MCP configuration so multiple pi instances run concurrently
 * without interference or port collisions.
 */

import { EventEmitter } from "node:events";
import { AntigravityClient, type ServerInfo } from "antigravity-client";
import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as fs from "node:fs";
import type { McpBridgeServer } from "./tool-bridge/mcp-server.js";

export interface LsConnectionOptions {
  workspacePath?: string;
  mcpServer?: McpBridgeServer;
  verbose?: boolean;
  binaryPath?: string;
  healthCheckTimeoutMs?: number;
}

export const ANTIGRAVITY_IDE_VERSION = "2.28.1";
export const LS_HEALTH_CHECK_TIMEOUT_MS = 5000;
const DEFAULT_LS_BINARY = "/opt/Antigravity/resources/bin/language_server";

/**
 * Checks whether a running Language Server process was started with a legacy IDE version.
 * Older versions (e.g. 1.107.0) lack modern reasoning effort tier models (M318/M319/M320).
 */
export function isLegacyServer(server: ServerInfo): boolean {
  if (!server.pid) return false;
  try {
    const cmdlinePath = `/proc/${server.pid}/cmdline`;
    if (fs.existsSync(cmdlinePath)) {
      const raw = fs.readFileSync(cmdlinePath, "utf8");
      if (raw.includes("1.107.0")) {
        return true;
      }
    }
  } catch {
    // If cmdline is unreadable (e.g. permission or container isolation), treat as non-legacy
  }
  return false;
}

export class LsConnection extends EventEmitter {
  private client: AntigravityClient | null = null;
  private lsProcess: ChildProcess | null = null;
  private connectingPromise: Promise<AntigravityClient> | null = null;
  private workspacePath: string;
  private mcpServer: McpBridgeServer | null = null;
  private verbose: boolean;
  private binaryPath?: string;
  private healthCheckTimeoutMs: number;
  private _generation = 0;

  constructor(options: LsConnectionOptions = {}) {
    super();
    this.workspacePath = options.workspacePath || process.cwd();
    this.mcpServer = options.mcpServer || null;
    this.verbose = options.verbose ?? false;
    this.binaryPath = options.binaryPath;
    this.healthCheckTimeoutMs = options.healthCheckTimeoutMs ?? LS_HEALTH_CHECK_TIMEOUT_MS;
  }

  get generation(): number {
    return this._generation;
  }

  isAlive(): boolean {
    if (!this.client) return false;
    if (this.lsProcess) {
      return !this.lsProcess.killed && this.lsProcess.exitCode === null;
    }
    return true;
  }

  setWorkspacePath(wsPath: string) {
    this.workspacePath = wsPath;
  }

  setMcpServer(mcpServer: McpBridgeServer) {
    this.mcpServer = mcpServer;
  }

  private async probe(client: AntigravityClient): Promise<void> {
    await client.lsClient.getUserStatus({}, { timeoutMs: this.healthCheckTimeoutMs });
  }

  private discardClient(): void {
    if (this.client) {
      try {
        this.client.dispose();
      } catch {
        // ignore
      }
      this.client = null;
    }

    if (this.lsProcess) {
      const proc = this.lsProcess;
      // Detach first so the async exit handler does not clear a newer process or emit stale events.
      this.lsProcess = null;
      if (!proc.killed && proc.exitCode === null) {
        try {
          proc.kill("SIGKILL");
        } catch {
          // ignore
        }
      }
    }
  }

  async ensureClient(): Promise<AntigravityClient> {
    const cached = this.client;
    if (cached) {
      try {
        await this.probe(cached);
        return cached;
      } catch {
        if (this.client === cached) {
          this.discardClient();
        } else if (this.client) {
          return this.client;
        }
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
    let client: AntigravityClient | null = null;

    // 1. Check for any running Antigravity LS only if explicitly allowed (D-01)
    const allowReuse = process.env.PI_AGLS_REUSE_LS === "1";
    if (allowReuse) {
      try {
        const servers = await AntigravityClient.listServers();
        for (const target of servers) {
          if (isLegacyServer(target)) {
            if (this.verbose) {
              console.error(`[LsConnection] Skipping legacy LS PID ${target.pid}`);
            }
            continue;
          }
          let candidate: AntigravityClient | null = null;
          try {
            candidate = await AntigravityClient.connectWithServer(target);
            await this.probe(candidate);
            client = candidate;
            if (this.verbose) {
              console.error(`[LsConnection] Reusing running LS PID ${target.pid}`);
            }
            break;
          } catch {
            try {
              candidate?.dispose();
            } catch {
              // ignore
            }
            // candidate failed, try next
          }
        }
      } catch {
        client = null;
      }
    }

    // 2. Launch LS if no running instance available
    if (!client) {
      if (this.verbose) {
        console.error(`[LsConnection] Spawning authentic Antigravity LS for ${this.workspacePath}`);
      }

      const binary =
        this.binaryPath ||
        process.env.CODEIUM_LANGUAGE_SERVER_BIN ||
        (fs.existsSync(DEFAULT_LS_BINARY) ? DEFAULT_LS_BINARY : "language_server");

      const csrfToken = crypto.randomUUID();

      const args = [
        "--standalone",
        "--override_ide_name", "antigravity",
        "--subclient_type", "hub",
        "--override_ide_version", ANTIGRAVITY_IDE_VERSION,
        "--override_user_agent_name", "antigravity",
        "--https_server_port", "0",
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

      proc.stdin.end();

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
        if (this.lsProcess === proc) {
          if (this.client) {
            try {
              this.client.dispose();
            } catch {
              // ignore
            }
            this.client = null;
          }
          this.lsProcess = null;
          this.emit("exit", { code, signal });
          this.emit("disconnect");
        }
      });

      // Wait for the HTTPS port line
      const httpsPort = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            reject(new Error("Timeout waiting for Antigravity LS HTTPS port"));
          }
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
            resolved = true;
            clearTimeout(timer);
            reject(err);
          }
        });

        proc.once("exit", (code, signal) => {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            reject(
              new Error(
                `Antigravity LS exited before reporting HTTPS port (code=${code}, signal=${signal})`
              )
            );
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

      client = await AntigravityClient.connectWithServer(serverInfo);
    }

    // 3. Register instance-unique MCP config and notify LS immediately
    if (this.mcpServer) {
      this.mcpServer.registerInMcpConfig();
      try {
        await client.refreshMcpServers();
        if (this.verbose) {
          console.error(`[LsConnection] Refreshed MCP servers in LS for ${this.mcpServer.serverName}`);
        }
      } catch {
        // ignore
      }
    }

    this.client = client;
    this._generation++;
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
