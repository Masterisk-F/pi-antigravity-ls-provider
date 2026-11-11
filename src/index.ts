/**
 * pi-antigravity-ls-provider: Extension Entry Point
 *
 * Connects pi directly to Antigravity Language Server (official binary) via ConnectRPC.
 * Runs in complete process and directory isolation per pi instance.
 */

import type { ExtensionAPI, ExtensionContext, ToolInfo } from "@earendil-works/pi-coding-agent";
import { LsConnection } from "./ls-connection.js";
import { RoundTrip } from "./tool-bridge/round-trip.js";
import { McpBridgeServer } from "./tool-bridge/mcp-server.js";
import { CascadeManager } from "./cascade-manager.js";
import { ModelCatalog } from "./models.js";
import { createStreamSimple } from "./provider-stream.js";
import { BindingStore } from "./bindings.js";

/**
 * Returns only the tools pi currently declares to the model (`pi.getActiveTools()`).
 * `pi.getAllTools()` also lists registered-but-inactive tools (grep, ls, find, powershell,
 * deferred MCP tools, ...) which the model must never be offered over MCP.
 */
export function getActivePiTools(
  pi: Pick<ExtensionAPI, "getAllTools" | "getActiveTools">
): ToolInfo[] {
  const activeNames = new Set(pi.getActiveTools());
  return pi.getAllTools().filter((tool) => activeNames.has(tool.name));
}

export default async function (pi: ExtensionAPI) {
  const roundTrip = new RoundTrip();
  const bindingStore = new BindingStore();

  const mcpServer = new McpBridgeServer({
    toolsProvider: () => getActivePiTools(pi),
    roundTrip,
    verbose: false,
  });

  const lsConnection = new LsConnection({
    workspacePath: process.cwd(),
    mcpServer,
    verbose: false,
  });

  const modelCatalog = new ModelCatalog();
  const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);

  // Start MCP HTTP bridge server (listens on random available port)
  try {
    await mcpServer.start();
  } catch (e: any) {
    console.error(`[antigravity-ls] Failed to start MCP bridge:`, e.message);
  }

  const models = modelCatalog.getModels();

  const streamSimple = createStreamSimple({
    lsConnection,
    cascadeManager,
    roundTrip,
    modelCatalog,
    mcpServer,
    verbose: false,
  });

  pi.registerProvider("antigravity-ls", {
    name: "Antigravity LS",
    baseUrl: "http://127.0.0.1",
    apiKey: "antigravity-ls",
    api: "antigravity-ls" as any,
    models: models as any,
    streamSimple,
  });

  // ── Tool execution lifecycle ──
  // Immediately resolve parked MCP tool calls as soon as Pi finishes executing them.
  // This ensures tools returning `terminate: true` (e.g. plannotator_submit_plan)
  // or tools aborted mid-execution return their HTTP response to the Language Server
  // right away rather than hanging open across the idle review/wait period. (D-02)
  pi.on("tool_result", async (event: any) => {
    if (event?.toolCallId) {
      roundTrip.resolve(event.toolCallId, event);
    }
  });

  // ── Agent settlement lifecycle ──
  // When Pi's agent run has fully settled and becomes idle (e.g. after a terminating tool
  // like plannotator_submit_plan, or user abort), explicitly cancel the Language Server
  // invocation to deterministically force it into `status: idle`. (D-03)
  pi.on("agent_settled", async (_event: any, ctx: ExtensionContext) => {
    const sessionId = ctx.sessionManager.getSessionId();
    await cascadeManager.cancelCascade(sessionId);
  });

  // ── Session hooks ──
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    if (ctx.cwd) {
      lsConnection.setWorkspacePath(ctx.cwd);
    }
    mcpServer.registerInMcpConfig();
    const client = lsConnection.getClient();
    if (client) {
      try {
        await client.refreshMcpServers();
      } catch {
        // ignore
      }
    }
  });

  pi.on("session_shutdown", async () => {
    cascadeManager.clearAll();
    await mcpServer.stop();
    await lsConnection.stop();
  });

  // Handle process exit for one-shot mode (pi -p)
  process.on("beforeExit", () => {
    cascadeManager.clearAll();
    mcpServer.stop().catch(() => {});
    lsConnection.stop().catch(() => {});
  });

  // ── CLI Command: /agls ──
  pi.registerCommand("agls", {
    description: "Antigravity LS provider status and diagnostics",
    handler: async (args: string, ctx: ExtensionContext) => {
      const sub = args.trim().toLowerCase();

      if (sub === "clear") {
        const sessionId = ctx.sessionManager.getSessionId();
        cascadeManager.clearSession(sessionId);
        ctx.ui?.notify?.("Cleared Antigravity cascade binding for this session.", "info");
        return;
      }

      if (sub === "clear-all") {
        cascadeManager.clearAll();
        ctx.ui?.notify?.("Cleared all Antigravity cascade bindings.", "info");
        return;
      }

      // Default: doctor / status
      let lsStatus = "Not connected";
      const client = lsConnection.getClient();
      if (client) {
        try {
          const userStatus = await client.getUserStatus();
          const us = userStatus.userStatus as any;
          lsStatus = `Connected (Email: ${us?.email || "N/A"}, Tier: ${us?.userTier?.name || "N/A"})`;
        } catch (e: any) {
          lsStatus = `Error: ${e.message}`;
        }
      }

      const activeBinding = bindingStore.get(ctx.sessionManager.getSessionId());

      const report = [
        "=== Antigravity LS Provider Doctor ===",
        `LS Status:     ${lsStatus}`,
        `MCP Server:    ${mcpServer.serverUrl} (Key: ${mcpServer.serverName}, Port: ${mcpServer.listeningPort})`,
        `Loaded Models: ${models.length} models`,
        `Active Cascade: ${activeBinding?.cascadeId || "(none yet)"}`,
        `Rewind Points: ${Object.keys(activeBinding?.steps || {}).length} recorded steps`,
        "",
        "Commands:",
        "  /agls          - Show this status",
        "  /agls clear    - Reset cascade binding for current session",
        "  /agls clear-all- Reset all session cascade bindings",
      ].join("\n");

      if (ctx.ui?.notify) {
        ctx.ui.notify(report, "info");
      } else {
        console.log(report);
      }
    },
  });
}
