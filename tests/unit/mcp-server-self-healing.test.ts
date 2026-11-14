import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { McpBridgeServer, isProcessAlive, TOKEN_HEADER } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";

describe("McpBridgeServer Self-Healing & Ghost Purging (Unit)", () => {
  it("isProcessAlive correctly identifies current process and nonexistent process", () => {
    assert.strictEqual(isProcessAlive(process.pid), true);
    // PID 9999999 unlikely to exist
    assert.strictEqual(isProcessAlive(9999999), false);
    assert.strictEqual(isProcessAlive(-1), false);
    assert.strictEqual(isProcessAlive(0), false);
  });

  it("purges dead pi-tools-<pid> entries while preserving existing user tools and live entries", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-ghost-test-"));
    const cfgPath = path.join(tmpDir, "mcp_config.json");

    // Config containing an existing user tool, a dead pi-tools entry, and another live entry
    const initialConfig = {
      mcpServers: {
        "existing-custom-tool": { url: "http://127.0.0.1:12345/mcp" },
        "pi-tools-9999999": { url: "http://127.0.0.1:54321/mcp" },
        [`pi-tools-${process.pid}`]: { url: "http://127.0.0.1:55555/mcp" },
      },
    };
    fs.writeFileSync(cfgPath, JSON.stringify(initialConfig, null, 2), "utf8");

    const rt = new RoundTrip();
    const server = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip: rt,
      instanceId: "new-instance",
      configDirs: [tmpDir],
    });
    await server.start();

    try {
      server.registerInMcpConfig();

      const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      // 1. Dead PID entry must be purged
      assert.strictEqual(config.mcpServers["pi-tools-9999999"], undefined);
      // 2. Existing custom tool must remain intact
      assert.ok(config.mcpServers["existing-custom-tool"]);
      // 3. Current process entry must remain intact
      assert.ok(config.mcpServers[`pi-tools-${process.pid}`]);
      // 4. New instance entry must be registered
      assert.ok(config.mcpServers[server.serverName]);
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("ensureRegistered detects missing or corrupted entry, self-heals and refreshes LS", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-heal-test-"));
    const cfgPath = path.join(tmpDir, "mcp_config.json");

    const rt = new RoundTrip();
    const server = new McpBridgeServer({
      toolsProvider: () => [],
      roundTrip: rt,
      instanceId: "heal-inst",
      configDirs: [tmpDir],
    });
    await server.start();

    let refreshCalled = 0;
    const mockClient = {
      refreshMcpServers: async () => {
        refreshCalled++;
      },
    };

    try {
      // 1. Initial register
      server.registerInMcpConfig();
      assert.ok(fs.existsSync(cfgPath));

      // Check when entry is valid: ensureRegistered should return false, no refresh needed
      const healed1 = await server.ensureRegistered(mockClient);
      assert.strictEqual(healed1, false);
      assert.strictEqual(refreshCalled, 0);

      // 2. Simulate external wipe (e.g. legacy test run or accidental delete)
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ mcpServers: { "existing-tool": {} } }, null, 2),
        "utf8"
      );

      // ensureRegistered should detect missing entry, self-heal and call refreshMcpServers
      const healed2 = await server.ensureRegistered(mockClient);
      assert.strictEqual(healed2, true);
      assert.strictEqual(refreshCalled, 1);

      // Verify the entry was restored
      const configAfterHeal = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.ok(configAfterHeal.mcpServers[server.serverName]);
      assert.strictEqual(configAfterHeal.mcpServers[server.serverName].url, server.serverUrl);

      // 3. Simulate corrupted token / url
      configAfterHeal.mcpServers[server.serverName].headers[TOKEN_HEADER] = "corrupted-token";
      fs.writeFileSync(cfgPath, JSON.stringify(configAfterHeal, null, 2), "utf8");

      const healed3 = await server.ensureRegistered(mockClient);
      assert.strictEqual(healed3, true);
      assert.strictEqual(refreshCalled, 2);

      const configAfterHeal3 = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
      assert.strictEqual(
        configAfterHeal3.mcpServers[server.serverName].headers[TOKEN_HEADER],
        server.bridgeToken
      );
    } finally {
      await server.stop();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
