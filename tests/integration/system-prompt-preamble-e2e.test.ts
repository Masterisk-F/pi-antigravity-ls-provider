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

describe(
  "System prompt sections.preamble replacement with live Antigravity LS (E2E)",
  { skip: !HAS_LS_BINARY, timeout: 120000 },
  () => {
    it("replaces sections.preamble for live LS turns, preserves other sections, and leaves content-only prompts intact", async () => {
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

        // 1. Structured system message with sections.preamble + other sections + mid-conversation patch
        currentTestSession = "e2e-sections-preamble";
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
                  preamble: "Arbitrary harness preamble that should be replaced.",
                  project_context: projectNote,
                  rules: "<rules>\n- Old rule\n</rules>",
                },
                timestamp: 1,
              },
              {
                role: "system",
                content: "",
                sections: {
                  rules: "<rules>\n- Be concise\n</rules>",
                },
                timestamp: 2,
              },
              {
                role: "user",
                content: "Reply with just: READY",
                timestamp: 3,
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
        assert.ok(text1.trim().length > 0, "live LS must return non-empty text");

        const sent1 = sentConfigs.find((c) => c.sessionId === "e2e-sections-preamble");
        assert.ok(sent1, "cascadeConfig must be captured for structured preamble turn");
        assert.strictEqual(
          sent1!.piSystemContent,
          `${NORMALIZED_PREAMBLE}\n\n${projectNote}\n\n<rules>\n- Be concise\n</rules>`,
          "sections.preamble must be replaced while preserving project_context and patched rules"
        );

        // 2. Plain content-only system message (no sections) must NOT be overwritten
        currentTestSession = "e2e-plain-system";
        const plainSystem =
          "You are a concise assistant whose secret callsign is SAPPHIRE-77.";
        const s2 = streamSimple(
          model,
          {
            messages: [
              {
                role: "system",
                content: plainSystem,
                timestamp: 10,
              },
              {
                role: "user",
                content: "What is your secret callsign? Reply with only the callsign.",
                timestamp: 11,
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
        assert.ok(
          text2.includes("SAPPHIRE-77"),
          `live LS must observe plain system prompt callsign SAPPHIRE-77, got: ${text2}`
        );

        const sent2 = sentConfigs.find((c) => c.sessionId === "e2e-plain-system");
        assert.ok(sent2, "cascadeConfig must be captured for plain system turn");
        assert.strictEqual(sent2!.piSystemContent, plainSystem);
      } finally {
        cascadeManager.disposeAll();
        await mcpServer.stop();
        await lsConnection.stop();
      }
    });
  }
);
