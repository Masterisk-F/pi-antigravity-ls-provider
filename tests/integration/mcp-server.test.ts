import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { McpBridgeServer, TOKEN_HEADER } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { getActivePiTools } from "../../src/index.js";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

describe("McpBridgeServer (Integration)", () => {
  const roundTrip = new RoundTrip();

  const mockTools = [
    {
      name: "write",
      description: "Write content to a file",
      parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } } },
    },
    {
      name: "custom_extension_tool",
      description: "A custom extension tool",
      parameters: { type: "object", properties: { query: { type: "string" } } },
    },
  ] as unknown as ToolInfo[];

  const server = new McpBridgeServer({
    toolsProvider: () => mockTools,
    roundTrip,
    verbose: false,
  });

  after(async () => {
    await server.stop();
  });

  test("starts HTTP server and handles tools/list", async () => {
    const port = await server.start();
    assert.ok(port > 0);

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TOKEN_HEADER]: server.bridgeToken,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.jsonrpc, "2.0");
    assert.equal(data.id, 1);
    assert.equal(data.result.tools.length, 2);
    assert.equal(data.result.tools[0].name, "write");
    assert.equal(data.result.tools[1].name, "custom_extension_tool");
  });

  test("handles tools/call round-trip", async () => {    const port = server.listeningPort;

    // Listen for park on round-trip to resolve it
    roundTrip.once("park", (ev) => {
      assert.equal(ev.toolName, "write");
      assert.deepEqual(ev.args, { path: "hello.txt", content: "world" });
      // Simulate pi execution resolution
      roundTrip.resolve(ev.callId, "File written successfully");
    });

    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        [TOKEN_HEADER]: server.bridgeToken,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "write",
          arguments: { path: "hello.txt", content: "world" },
        },
      }),
    });

    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.id, 2);
    assert.ok(data.result?.content);
    assert.equal(data.result.content[0].text, "File written successfully");
  });

  test("publishes every tool the provider returns (no hidden exclusion list)", async () => {
    // getActivePiTools only filters by pi's active set; nothing else may be dropped.
    const registered = mockTools.concat({
      name: "ls",
      description: "List directory entries",
      parameters: { type: "object", properties: {} },
    } as any);
    const names = mockTools.map((t) => t.name).concat("ls");

    const activeServer = new McpBridgeServer({
      toolsProvider: () =>
        getActivePiTools({
          getAllTools: () => registered as ToolInfo[],
          getActiveTools: () => names,
        }),
      roundTrip: new RoundTrip(),
      instanceId: "integration-publish",
    });

    try {
      const port = await activeServer.start();
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TOKEN_HEADER]: activeServer.bridgeToken,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }),
      });

      const data = (await res.json()) as any;
      assert.deepStrictEqual(
        data.result.tools.map((t: any) => t.name),
        ["write", "custom_extension_tool", "ls"]
      );
    } finally {
      await activeServer.stop();
    }
  });

  test("tools/list reflects a mid-session change of pi's active tool set", async () => {
    let activeNames = ["read", "bash"];
    const registered = ["read", "bash", "grep", "ls"].map(
      (name) =>
        ({
          name,
          description: `${name} tool`,
          parameters: { type: "object", properties: {} },
        }) as unknown as ToolInfo
    );

    const dynamicServer = new McpBridgeServer({
      toolsProvider: () =>
        getActivePiTools({
          getAllTools: () => registered,
          getActiveTools: () => activeNames,
        }),
      roundTrip: new RoundTrip(),
      instanceId: "integration-dynamic",
    });

    const list = async () => {
      const res = await fetch(`http://127.0.0.1:${dynamicServer.listeningPort}/mcp`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          [TOKEN_HEADER]: dynamicServer.bridgeToken,
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} }),
      });
      return ((await res.json()) as any).result.tools.map((t: any) => t.name);
    };

    try {
      await dynamicServer.start();

      assert.deepStrictEqual(await list(), ["read", "bash"]);
      assert.strictEqual(dynamicServer.consumeToolSetChanged(), false);

      activeNames = ["read", "bash", "grep"];
      assert.strictEqual(dynamicServer.consumeToolSetChanged(), true);
      assert.deepStrictEqual(await list(), ["read", "bash", "grep"]);
    } finally {
      await dynamicServer.stop();
    }
  });
});
