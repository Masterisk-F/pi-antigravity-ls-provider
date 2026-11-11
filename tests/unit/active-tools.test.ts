import { describe, it } from "node:test";
import * as assert from "node:assert";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import { getActivePiTools } from "../../src/index.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";

function tool(name: string): ToolInfo {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: "object", properties: {} },
  } as unknown as ToolInfo;
}

const ALL_TOOLS = [
  tool("read"),
  tool("bash"),
  tool("edit"),
  tool("write"),
  tool("grep"),
  tool("find"),
  tool("ls"),
  tool("powershell"),
  tool("advisor"),
];

function fakePi(active: string[]) {
  return {
    getAllTools: () => ALL_TOOLS,
    getActiveTools: () => active,
  };
}

describe("getActivePiTools (Unit)", () => {
  it("returns only the tools pi declares to the model", () => {
    const result = getActivePiTools(fakePi(["read", "bash", "edit", "write"]));
    assert.deepStrictEqual(
      result.map((t) => t.name),
      ["read", "bash", "edit", "write"]
    );
  });

  it("exposes explicitly enabled non-default tools such as ls and grep", () => {
    const result = getActivePiTools(fakePi(["read", "ls", "grep"]));
    assert.deepStrictEqual(
      result.map((t) => t.name),
      ["read", "grep", "ls"]
    );
  });

  it("returns an empty list when pi has no active tools", () => {
    assert.deepStrictEqual(getActivePiTools(fakePi([])), []);
  });

  it("ignores active names that are not registered", () => {
    const result = getActivePiTools(fakePi(["read", "does_not_exist"]));
    assert.deepStrictEqual(
      result.map((t) => t.name),
      ["read"]
    );
  });
});

describe("McpBridgeServer tool set tracking (Unit)", () => {
  it("reports no change before the first tools/list sync", () => {
    let active = ["read", "bash"];
    const server = new McpBridgeServer({
      toolsProvider: () => getActivePiTools(fakePi(active)),
      roundTrip: new RoundTrip(),
    });

    assert.strictEqual(server.consumeToolSetChanged(), false);
  });

  it("reports a change once when the active tool set moves, then stays quiet", () => {
    let active = ["read", "bash"];
    const server = new McpBridgeServer({
      toolsProvider: () => getActivePiTools(fakePi(active)),
      roundTrip: new RoundTrip(),
    });

    server.consumeToolSetChanged(); // establish baseline

    active = ["read", "bash", "edit"];
    assert.strictEqual(server.consumeToolSetChanged(), true);
    assert.strictEqual(server.consumeToolSetChanged(), false);
  });

  it("treats added and removed tools as changes", () => {
    let active = ["read", "bash"];
    const server = new McpBridgeServer({
      toolsProvider: () => getActivePiTools(fakePi(active)),
      roundTrip: new RoundTrip(),
    });
    server.consumeToolSetChanged();

    active = ["read"];
    assert.strictEqual(server.consumeToolSetChanged(), true);
    assert.strictEqual(server.consumeToolSetChanged(), false);
  });
});
