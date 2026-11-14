import { describe, it } from "node:test";
import * as assert from "node:assert";
import * as fs from "node:fs";
import { LsConnection } from "../../src/ls-connection.js";
import { McpBridgeServer } from "../../src/tool-bridge/mcp-server.js";
import { RoundTrip } from "../../src/tool-bridge/round-trip.js";
import { ModelCatalog } from "../../src/models.js";
import { CascadeManager } from "../../src/cascade-manager.js";
import { BindingStore } from "../../src/bindings.js";
import { createStreamSimple, NORMALIZED_PREAMBLE } from "../../src/provider-stream.js";

const HAS_LS_BINARY = fs.existsSync("/opt/Antigravity/resources/bin/language_server");

const V140_PREAMBLE =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const V150_PREAMBLE =
  "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";

describe(
  "System prompt sections.preamble replacement with live Antigravity LS (E2E)",
  { skip: !HAS_LS_BINARY, timeout: 120000 },
  () => {
    it("replaces default sections.preamble for live LS turns, preserves other sections, and keeps custom preambles", async () => {
      const roundTrip = new RoundTrip();
      const bindingStore = BindingStore.inMemory();
      const modelCatalog = new ModelCatalog();

      const mcpServer = new McpBridgeServer({ toolsProvider: () => [], roundTrip });
      await mcpServer.start();

      const lsConnection = new LsConnection({ mcpServer, verbose: false });
      const cascadeManager = new CascadeManager(lsConnection, bindingStore, false);
      const streamSimple = createStreamSimple({
        lsConnection,
        cascadeManager,
        roundTrip,
        modelCatalog,
        mcpServer,
        verbose: false,
      });

      const model = {
        id: "gemini-3.8-flash",
        name: "Gemini 3.8 Flash",
        provider: "antigravity-ls",
        api: "antigravity-ls",
      } as any;

      const sentConfigs: Array<{ sessionId: string; piSystemContent: string }> = [];

      try {
        const client = await lsConnection.ensureClient();
        const originalLsClient = client.lsClient;
        const originalSend = originalLsClient.sendUserCascadeMessage.bind(originalLsClient);
        let currentTestSession = "";

        client.lsClient = new Proxy(originalLsClient, {
          get(target, prop, receiver) {
            if (prop === "sendUserCascadeMessage") {
              return async (req: any) => {
                const sections =
                  req?.cascadeConfig?.plannerConfig?.plannerTypeConfig?.value?.promptSections ?? [];
                const piSystem = sections.find((s: any) => s?.item?.value?.title === "pi_system");
                if (piSystem) {
                  sentConfigs.push({
                    sessionId: currentTestSession,
                    piSystemContent: piSystem.item.value.content,
                  });
                }
                return originalSend(req);
              };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });

        // 1. pi v1.4.0 default preamble + project_context containing harness wording
        currentTestSession = "e2e-preamble-v140";
        const projectNote =
          "<project_context>\nDocumentation note: tests mention pi, a coding agent harness.\n</project_context>";
        const s1 = streamSimple(
          model,
          {
            messages: [
              {
                role: "system",
                content: "",
                sections: {
                  preamble: V140_PREAMBLE,
                  project_context: projectNote,
                },
                timestamp: 1,
              },
              {
                role: "user",
                content: "Reply with just: READY",
                timestamp: 2,
              },
            ],
          } as any,
          { sessionId: currentTestSession }
        );
        let text1 = "";
        for await (const ev of s1) {
          if (ev.type === "text_delta") text1 += ev.delta;
        }
        const r1 = await s1.result();
        assert.strictEqual(r1.stopReason, "stop");
        assert.ok(text1.trim().length > 0, "live LS must return non-empty text for v1.4.0 turn");

        const sent1 = sentConfigs.find((c) => c.sessionId === "e2e-preamble-v140");
        assert.ok(sent1, "cascadeConfig must be captured for v1.4.0 turn");
        assert.strictEqual(
          sent1!.piSystemContent,
          `${NORMALIZED_PREAMBLE}\n\n${projectNote}`,
          "v1.4.0 sections.preamble must be replaced while preserving project_context verbatim"
        );

        // 2. pi v1.5.0 default preamble + mid-conversation section patch
        currentTestSession = "e2e-preamble-v150";
        const s2 = streamSimple(
          model,
          {
            messages: [
              {
                role: "system",
                content: "",
                sections: {
                  preamble: V150_PREAMBLE,
                  rules: "<rules>\n- Be concise\n</rules>",
                },
                timestamp: 10,
              },
              {
                role: "system",
                content: "",
                sections: {
                  rules: "<rules>\n- Be concise and clear\n</rules>",
                },
                timestamp: 11,
              },
              {
                role: "user",
                content: "Reply with just: OK",
                timestamp: 12,
              },
            ],
          } as any,
          { sessionId: currentTestSession }
        );
        let text2 = "";
        for await (const ev of s2) {
          if (ev.type === "text_delta") text2 += ev.delta;
        }
        const r2 = await s2.result();
        assert.strictEqual(r2.stopReason, "stop");
        assert.ok(text2.trim().length > 0, "live LS must return non-empty text for v1.5.0 turn");

        const sent2 = sentConfigs.find((c) => c.sessionId === "e2e-preamble-v150");
        assert.ok(sent2, "cascadeConfig must be captured for v1.5.0 turn");
        assert.strictEqual(
          sent2!.piSystemContent,
          `${NORMALIZED_PREAMBLE}\n\n<rules>\n- Be concise and clear\n</rules>`,
          "v1.5.0 sections.preamble must be replaced and mid-conversation patch applied"
        );

        // 3. Custom sections.preamble must NOT be overwritten and live LS must observe it
        currentTestSession = "e2e-preamble-custom";
        const customPreamble =
          "You are a concise assistant whose secret callsign is SAPPHIRE-77.";
        const s3 = streamSimple(
          model,
          {
            messages: [
              {
                role: "system",
                content: "",
                sections: {
                  preamble: customPreamble,
                },
                timestamp: 20,
              },
              {
                role: "user",
                content: "What is your secret callsign? Reply with only the callsign.",
                timestamp: 21,
              },
            ],
          } as any,
          { sessionId: currentTestSession }
        );
        let text3 = "";
        for await (const ev of s3) {
          if (ev.type === "text_delta") text3 += ev.delta;
        }
        const r3 = await s3.result();
        assert.strictEqual(r3.stopReason, "stop");
        assert.ok(
          text3.includes("SAPPHIRE-77"),
          `live LS must observe custom preamble callsign SAPPHIRE-77, got: ${text3}`
        );

        const sent3 = sentConfigs.find((c) => c.sessionId === "e2e-preamble-custom");
        assert.ok(sent3, "cascadeConfig must be captured for custom preamble turn");
        assert.strictEqual(sent3!.piSystemContent, customPreamble);
      } finally {
        cascadeManager.disposeAll();
        await mcpServer.stop();
        await lsConnection.stop();
      }
    });
  }
);
