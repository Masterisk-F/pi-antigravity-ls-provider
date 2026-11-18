import { describe, it } from "node:test";
import * as assert from "node:assert";
import { buildDoctorReport } from "../../src/index.js";

describe("buildDoctorReport (Unit)", () => {
  it("formats the doctor report without Rewind Points when cascadeId is present", () => {
    const report = buildDoctorReport({
      lsStatus: "Connected (Email: user@example.com, Tier: PRO)",
      serverUrl: "http://127.0.0.1:41235",
      serverName: "antigravity-mcp-1234",
      listeningPort: 41235,
      modelsCount: 5,
      cascadeId: "cas_abc123",
    });

    // Verify Rewind Points is NOT included
    assert.strictEqual(report.includes("Rewind Points"), false);

    // Verify key fields are present
    assert.strictEqual(
      report.includes("LS Status:     Connected (Email: user@example.com, Tier: PRO)"),
      true
    );
    assert.strictEqual(
      report.includes("MCP Server:    http://127.0.0.1:41235 (Key: antigravity-mcp-1234, Port: 41235)"),
      true
    );
    assert.strictEqual(report.includes("Loaded Models: 5 models"), true);
    assert.strictEqual(report.includes("Active Cascade: cas_abc123"), true);
    assert.strictEqual(report.includes("Commands:"), true);

    const expected = [
      "=== Antigravity LS Provider Doctor ===",
      "LS Status:     Connected (Email: user@example.com, Tier: PRO)",
      "MCP Server:    http://127.0.0.1:41235 (Key: antigravity-mcp-1234, Port: 41235)",
      "Loaded Models: 5 models",
      "Active Cascade: cas_abc123",
      "",
      "Commands:",
      "  /agls          - Show this status",
      "  /agls clear    - Reset cascade binding for current session",
      "  /agls clear-all- Reset all session cascade bindings",
    ].join("\n");

    assert.strictEqual(report, expected);
  });

  it("handles null or undefined cascadeId by falling back to (none yet)", () => {
    const reportNull = buildDoctorReport({
      lsStatus: "Not connected",
      serverUrl: "http://127.0.0.1:41235",
      serverName: "antigravity-mcp-1234",
      listeningPort: 41235,
      modelsCount: 0,
      cascadeId: null,
    });

    assert.strictEqual(reportNull.includes("Rewind Points"), false);
    assert.strictEqual(reportNull.includes("Active Cascade: (none yet)"), true);

    const reportUndefined = buildDoctorReport({
      lsStatus: "Not connected",
      serverUrl: "http://127.0.0.1:41235",
      serverName: "antigravity-mcp-1234",
      listeningPort: 41235,
      modelsCount: 0,
    });

    assert.strictEqual(reportUndefined.includes("Rewind Points"), false);
    assert.strictEqual(reportUndefined.includes("Active Cascade: (none yet)"), true);
  });
});
