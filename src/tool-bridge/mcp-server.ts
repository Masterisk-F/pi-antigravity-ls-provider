/**
 * Streamable HTTP MCP Server exposing all pi tools to Antigravity LS.
 * Uses instance-unique server names (pi-tools-<pid>) to support multiple concurrent pi instances
 * without port or configuration collision, while preserving user's existing MCP settings.
 */

import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { RoundTrip } from "./round-trip.js";

export const TOKEN_HEADER = "x-bridge-token";

export interface McpServerOptions {
  toolsProvider: () => ToolInfo[];
  roundTrip: RoundTrip;
  instanceId?: string | number;
  verbose?: boolean;
  configDirs?: string[];
}

export function isProcessAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: any) {
    // ESRCH means process does not exist; EPERM means exists but owned by someone else
    return err.code === "EPERM";
  }
}

export class McpBridgeServer {
  private server: http.Server | null = null;
  private port = 0;
  private token: string;
  private toolsProvider: () => ToolInfo[];
  private roundTrip: RoundTrip;
  private instanceId: string | number;
  private verbose: boolean;
  private customConfigDirs: string[] | null = null;
  private registeredConfigPaths: string[] = [];
  private lastSyncedToolSignature: string | null = null;

  constructor(options: McpServerOptions) {
    this.toolsProvider = options.toolsProvider;
    this.roundTrip = options.roundTrip;
    this.instanceId = options.instanceId ?? process.pid;
    this.verbose = options.verbose ?? false;
    this.customConfigDirs = options.configDirs ? [...options.configDirs] : null;
    this.token = crypto.randomUUID();
  }

  get serverName(): string {
    return `pi-tools-${this.instanceId}`;
  }

  private toolSignature(tools: ToolInfo[]): string {
    return tools
      .map((t) => t.name)
      .sort()
      .join(",");
  }

  private recordToolSignature(tools: ToolInfo[]): void {
    this.lastSyncedToolSignature = this.toolSignature(tools);
  }

  /**
   * Whether the active tool set changed since the Language Server last received `tools/list`.
   * Consumes the change: the first caller after a change gets `true`, later callers get `false`.
   * This lets the provider refresh the LS tool catalog only on turns where it actually moved.
   */
  consumeToolSetChanged(): boolean {
    const current = this.toolSignature(this.toolsProvider());
    const changed = this.lastSyncedToolSignature !== null && current !== this.lastSyncedToolSignature;
    this.lastSyncedToolSignature = current;
    return changed;
  }

  get listeningPort(): number {
    return this.port;
  }

  get bridgeToken(): string {
    return this.token;
  }

  get serverUrl(): string {
    return `http://127.0.0.1:${this.port}/mcp`;
  }

  async start(): Promise<number> {
    if (this.server) return this.port;

    this.server = http.createServer((req, res) => {
      this.handleHttpRequest(req, res);
    });

    return new Promise<number>((resolve, reject) => {
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr !== "string") {
          this.port = addr.port;
        }
        if (this.verbose) {
          console.error(`[McpBridgeServer] Listening on ${this.serverUrl} (${this.serverName})`);
        }
        this.server!.unref();
        resolve(this.port);
      });
      this.server!.on("error", reject);
    });
  }

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    // Basic CORS / Header checks
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
        "Access-Control-Allow-Headers": `Content-Type, ${TOKEN_HEADER}`,
      });
      res.end();
      return;
    }

    // Token verification (for non-discovery requests)
    const headerToken = req.headers[TOKEN_HEADER];
    // In local development or during discover, allow initial handshake, but check token if present
    if (headerToken && headerToken !== this.token) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized token" }));
      return;
    }

    if (req.method !== "POST") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", async () => {
      let rpc: any;
      try {
        rpc = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      await this.handleJsonRpc(rpc, res);
    });
  }

  private async handleJsonRpc(rpc: any, res: http.ServerResponse): Promise<void> {
    const id = rpc.id;
    const method = rpc.method;

    if (this.verbose) {
      console.error(`[McpBridgeServer] RPC Method: ${method}`);
    }

    if (method === "server/discover" || method === "initialize") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: rpc.params?.protocolVersion || "2024-11-05",
            capabilities: {
              tools: {},
            },
            serverInfo: {
              name: this.serverName,
              version: "1.0.0",
            },
          },
        })
      );
      return;
    }

    if (method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }

    if (method === "tools/list") {
      // Published tools are exactly what toolsProvider() returns (already filtered to pi's
      // active tool set upstream). No hardcoded exclusion list belongs here.
      const allTools = this.toolsProvider();
      this.recordToolSignature(allTools);
      const mcpTools = allTools.map((t) => ({
        name: t.name,
        description: t.description || `Pi tool ${t.name}`,
        inputSchema: t.parameters || { type: "object", properties: {} },
      }));

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: { tools: mcpTools },
        })
      );
      return;
    }

    if (method === "tools/call") {
      const toolName = rpc.params?.name;
      const toolArgs = rpc.params?.arguments || {};
      const callId = `call_${crypto.randomUUID()}`;

      if (this.verbose) {
        console.error(`[McpBridgeServer] tools/call: ${toolName}`, toolArgs);
      }

      try {
        const rawResult = await this.roundTrip.park(callId, toolName, toolArgs);

        let textResult = "";
        if (typeof rawResult === "string") {
          textResult = rawResult;
        } else if (rawResult && typeof rawResult === "object") {
          if (Array.isArray(rawResult.content)) {
            textResult = rawResult.content
              .map((c: any) => (typeof c === "string" ? c : c.text ?? JSON.stringify(c)))
              .join("\n");
          } else if (typeof rawResult.text === "string") {
            textResult = rawResult.text;
          } else {
            textResult = JSON.stringify(rawResult);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: textResult || "(completed)",
                },
              ],
            },
          })
        );
      } catch (err: any) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id,
            error: {
              code: -32603,
              message: err?.message || `Tool ${toolName} execution failed`,
            },
          })
        );
      }
      return;
    }

    // Default response for other methods (ping, etc.)
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id, result: {} }));
  }

  private getConfigDirs(): string[] {
    if (this.customConfigDirs && this.customConfigDirs.length > 0) {
      return this.customConfigDirs;
    }
    return [
      path.join(os.homedir(), ".gemini", "config"),
      path.join(os.homedir(), ".gemini", "antigravity"),
    ];
  }

  private writeConfigAtomic(cfgPath: string, config: any): void {
    const dir = path.dirname(cfgPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${cfgPath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf8");
      fs.renameSync(tmpPath, cfgPath);
    } catch (err) {
      try {
        if (fs.existsSync(tmpPath)) {
          fs.unlinkSync(tmpPath);
        }
      } catch {
        // ignore
      }
      throw err;
    }
  }

  /**
   * Safely registers this instance's unique MCP entry in mcp_config.json.
   * Completely preserves all existing user/other-pi MCP configurations.
   * Automatically purges ghost entries from dead pi processes (D-03) and writes atomically (D-04).
   */
  registerInMcpConfig(): void {
    const configDirs = this.getConfigDirs();

    for (const dir of configDirs) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        const cfgPath = path.join(dir, "mcp_config.json");
        let config: any = { mcpServers: {} };

        if (fs.existsSync(cfgPath)) {
          try {
            config = JSON.parse(fs.readFileSync(cfgPath, "utf8")) || { mcpServers: {} };
          } catch {
            config = { mcpServers: {} };
          }
        }

        if (!config.mcpServers || typeof config.mcpServers !== "object") {
          config.mcpServers = {};
        }

        // Clean up legacy static "pi-tools" entry if present
        if (config.mcpServers["pi-tools"]) {
          delete config.mcpServers["pi-tools"];
        }

        // Purge dead pi-tools-<pid> ghost entries (D-03)
        for (const key of Object.keys(config.mcpServers)) {
          if (key === this.serverName) continue;
          const match = key.match(/^pi-tools-(\d+)$/);
          if (match) {
            const pid = parseInt(match[1], 10);
            if (!isProcessAlive(pid)) {
              if (this.verbose) {
                console.error(`[McpBridgeServer] Purging stale ghost entry ${key} (PID ${pid} is dead)`);
              }
              delete config.mcpServers[key];
            }
          }
        }

        // Add instance-unique server entry without clobbering other tools
        config.mcpServers[this.serverName] = {
          url: this.serverUrl,
          headers: {
            [TOKEN_HEADER]: this.token,
          },
        };

        this.writeConfigAtomic(cfgPath, config);
        if (!this.registeredConfigPaths.includes(cfgPath)) {
          this.registeredConfigPaths.push(cfgPath);
        }
        if (this.verbose) {
          console.error(`[McpBridgeServer] Registered ${this.serverName} in ${cfgPath}`);
        }
      } catch (e: any) {
        if (this.verbose) {
          console.error(`[McpBridgeServer] Failed to write mcp_config.json at ${dir}:`, e.message);
        }
      }
    }
  }

  /**
   * Ensures that this instance's MCP entry is currently present and correct in all config files.
   * If missing or modified (e.g. wiped by a test run or external process), re-registers and
   * triggers client.refreshMcpServers() immediately (D-01: Self-Healing).
   * Returns true if self-healing occurred, false if configuration was already valid.
   */
  async ensureRegistered(client?: { refreshMcpServers: () => Promise<any> }): Promise<boolean> {
    const configDirs = this.getConfigDirs();
    let needsRegister = false;

    for (const dir of configDirs) {
      const cfgPath = path.join(dir, "mcp_config.json");
      try {
        if (!fs.existsSync(cfgPath)) {
          needsRegister = true;
          break;
        }
        const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
        const entry = config?.mcpServers?.[this.serverName];
        if (!entry || entry.url !== this.serverUrl || entry.headers?.[TOKEN_HEADER] !== this.token) {
          needsRegister = true;
          break;
        }
      } catch {
        needsRegister = true;
        break;
      }
    }

    if (needsRegister) {
      if (this.verbose) {
        console.error(`[McpBridgeServer] Self-healing triggered: ${this.serverName} missing or invalid in config. Re-registering.`);
      }
      this.registerInMcpConfig();
      if (client) {
        try {
          await client.refreshMcpServers();
          if (this.verbose) {
            console.error(`[McpBridgeServer] Refreshed MCP servers after self-healing for ${this.serverName}`);
          }
        } catch (e: any) {
          if (this.verbose) {
            console.error(`[McpBridgeServer] Failed to refresh MCP servers in client: ${e.message}`);
          }
        }
      }
      return true;
    }

    return false;
  }

  /**
   * Safely removes ONLY this instance's unique entry (pi-tools-<pid>), leaving all other tools intact.
   */
  async stop(): Promise<void> {
    const configPaths = this.registeredConfigPaths.length > 0
      ? [...this.registeredConfigPaths]
      : this.getConfigDirs().map((d) => path.join(d, "mcp_config.json"));

    for (const cfgPath of configPaths) {
      try {
        if (fs.existsSync(cfgPath)) {
          const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
          if (config?.mcpServers?.[this.serverName]) {
            delete config.mcpServers[this.serverName];
            this.writeConfigAtomic(cfgPath, config);
          }
        }
      } catch {
        // ignore
      }
    }
    this.registeredConfigPaths = [];

    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }
  }
}
