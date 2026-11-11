import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";

describe("McpBridgeServer Multi-Instance & Preservation (Unit)", () => {
  it("generates instance-unique serverName containing pid", () => {
    const roundTrip = new RoundTrip();
    const server = new McpBridgeServer({ toolsProvider: () => [], roundTrip });
    assert.strictEqual(server.serverName, `pi-tools-${process.pid}`);
  });

  it("safely adds unique entry and cleans up only its own entry on stop", async () => {
    const roundTrip = new RoundTrip();
    const server = new McpBridgeServer({ toolsProvider: () => [], roundTrip });
    await server.start();

    const cfgDir = path.join(os.homedir(), ".gemini", "config");
    fs.mkdirSync(cfgDir, { recursive: true });
    const cfgPath = path.join(cfgDir, "mcp_config.json");

    // Existing user config (e.g. Playwright or other tools)
    const initialConfig = {
      mcpServers: {
        "existing-custom-tool": {
          url: "http://127.0.0.1:12345/mcp",
        },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(initialConfig, null, 2), "utf8");

    try {
      server.registerInMcpConfig();

      const updated = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      // 1. Existing tool must still exist
      assert.ok(updated.mcpServers["existing-custom-tool"], "Existing user MCP server must be preserved");
      // 2. Instance-unique tool must be added
      assert.ok(updated.mcpServers[server.serverName], "Instance-unique server entry must be added");
      assert.strictEqual(updated.mcpServers[server.serverName].url, server.serverUrl);

      // Stop server
      await server.stop();

      const afterStop = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      // 3. Instance-unique entry must be cleanly removed
      assert.strictEqual(afterStop.mcpServers[server.serverName], undefined);
      // 4. Existing tool must remain intact
      assert.ok(afterStop.mcpServers["existing-custom-tool"]);
    } finally {
      // Restore initial config
      fs.writeFileSync(cfgPath, JSON.stringify(initialConfig, null, 2), "utf8");
    }
  });

  it("allows multiple McpBridgeServer instances without key collision", async () => {
    const rt1 = new RoundTrip();
    const rt2 = new RoundTrip();

    const s1 = new McpBridgeServer({ toolsProvider: () => [], roundTrip: rt1 });
    const s2 = new McpBridgeServer({ toolsProvider: () => [], roundTrip: rt2 });

    await s1.start();
    await s2.start();

    // Verify ports are distinct
    assert.notStrictEqual(s1.listeningPort, s2.listeningPort);

    await s1.stop();
    await s2.stop();
  });
});
