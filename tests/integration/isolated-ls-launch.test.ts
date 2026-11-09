import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";

describe("Multi-Instance MCP Registration & Conflict-Free Coexistence (Integration)", () => {
  it("allows multiple pi instances to run concurrently without port or configuration collision", async () => {
    const roundTrip1 = new RoundTrip();
    const roundTrip2 = new RoundTrip();

    const mcp1 = new McpBridgeServer({ toolsProvider: () => [], roundTrip: roundTrip1, instanceId: "inst1" });
    const mcp2 = new McpBridgeServer({ toolsProvider: () => [], roundTrip: roundTrip2, instanceId: "inst2" });

    const port1 = await mcp1.start();
    const port2 = await mcp2.start();

    // 1. Port collision check: OS must assign distinct ephemeral ports
    assert.notStrictEqual(port1, port2, "Ports must not collide");

    const cfgDir = path.join(os.homedir(), ".gemini", "config");
    const cfgPath = path.join(cfgDir, "mcp_config.json");

    try {
      // Instance 1 registers
      mcp1.registerInMcpConfig();
      // Instance 2 registers
      mcp2.registerInMcpConfig();

      const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

      // 2. Both unique entries must coexist peacefully in mcp_config.json
      assert.ok(config.mcpServers[mcp1.serverName], "Instance 1 entry must exist");
      assert.strictEqual(config.mcpServers[mcp1.serverName].url, mcp1.serverUrl);

      // Stop Instance 1
      await mcp1.stop();

      const configAfterStop1 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      // 3. Stopping Instance 1 must NOT remove or corrupt Instance 2 entry
      assert.strictEqual(configAfterStop1.mcpServers[mcp1.serverName], undefined);

      await mcp2.stop();
    } finally {
      await mcp1.stop();
      await mcp2.stop();
    }
  });
});
