/**
 * streamSimple implementation for Antigravity LS Provider.
 *
 * Connects pi's streaming tool loop with Antigravity's Cascade agent loop.
 */

import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type SimpleStreamOptions,
  type TranscriptContext,
  type Model,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { Cascade } from "antigravity-client";
import type { LsConnection } from "./ls-connection.js";
import type { CascadeManager } from "./cascade-manager.js";
import type { RoundTrip, ParkEvent } from "./tool-bridge/round-trip.js";
import type { ModelCatalog } from "./models.js";
import { buildCascadeConfig } from "./cascade-config.js";

import type { McpBridgeServer } from "./tool-bridge/mcp-server.js";

export interface ProviderStreamDeps {
  lsConnection: LsConnection;
  cascadeManager: CascadeManager;
  roundTrip: RoundTrip;
  modelCatalog: ModelCatalog;
  mcpServer?: McpBridgeServer;
  verbose?: boolean;
}

export function createStreamSimple(deps: ProviderStreamDeps) {
  const { lsConnection, cascadeManager, roundTrip, modelCatalog, mcpServer, verbose } = deps;

  return function streamSimple(
    model: Model<any>,
    context: TranscriptContext,
    options?: SimpleStreamOptions
  ): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const sessionId = options?.sessionId || "default-session";
    const signal = options?.signal;

    // Run asynchronously to allow stream object return immediately
    queueMicrotask(async () => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      };

      if (signal?.aborted) {
        message.stopReason = "aborted";
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
        return;
      }

      try {
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: "start", partial: message });

        // 1. Check for incoming tool results to resolve parked MCP calls
        const recentMessages = context.messages.slice(-5);
        for (const msg of recentMessages) {
          if (msg.role === "toolResult") {
            const tr = msg as ToolResultMessage;
            if (roundTrip.resolve(tr.toolCallId, tr)) {
              if (verbose) {
                console.error(`[provider-stream] Resolved parked MCP call for ${tr.toolCallId}`);
              }
            }
          }
        }

        const { numericId: numericModelId, modelName } = modelCatalog.resolveModel(
          model.id,
          options?.reasoning
        );

        // Extract system prompt
        let systemPrompt = "You are an expert AI software engineer operating as a coding agent.";
        for (const msg of context.messages) {
          if (msg.role === "system") {
            if (typeof msg.content === "string") {
              systemPrompt = msg.content;
            } else if (Array.isArray(msg.content)) {
              systemPrompt = msg.content
                .map((c: any) => c.text || "")
                .filter(Boolean)
                .join("\n");
            }
          }
        }

        // Get or synchronize the turn's Cascade
        const cascade = await cascadeManager.ensureTurnCascade({
          sessionId,
          branch: context.messages as any,
          modelId: numericModelId,
          modelName,
          systemPrompt,
          mcpServerName: mcpServer?.serverName,
        });

        // 2. Prepare listeners BEFORE sending user message to eliminate any event-loss races (D-05)
        let textBlock: TextContent | null = null;
        let thinkingBlock: ThinkingContent | null = null;
        let isDone = false;
        let hasStarted = false;

        const cleanupListeners = () => {
          cascade.off("text", onText);
          cascade.off("thinking", onThinking);
          cascade.off("statusChange", onStatusChange);
          cascade.off("stepNew", onStepNew);
          roundTrip.off("park", onPark);
          signal?.removeEventListener("abort", onAbort);
        };

        const onAbort = () => {
          if (isDone) return;
          isDone = true;
          cleanupListeners();
          cascade.cancel().catch(() => {});
          roundTrip.abortAll("Turn aborted");
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
          stream.end(message);
        };

        signal?.addEventListener("abort", onAbort, { once: true });

        const onStepNew = () => {
          hasStarted = true;
        };

        const onText = (d: { delta: string; fullText?: string }) => {
          if (isDone) return;
          hasStarted = true;
          if (!textBlock) {
            textBlock = { type: "text", text: "" };
            message.content.push(textBlock);
            const idx = message.content.length - 1;
            stream.push({ type: "text_start", contentIndex: idx, partial: message });
          }
          textBlock.text += d.delta;
          const idx = message.content.indexOf(textBlock);
          stream.push({
            type: "text_delta",
            contentIndex: idx,
            delta: d.delta,
            partial: message,
          });
        };

        const onThinking = (d: { delta: string }) => {
          if (isDone) return;
          hasStarted = true;
          if (!thinkingBlock) {
            thinkingBlock = { type: "thinking", thinking: "" };
            message.content.push(thinkingBlock);
            const idx = message.content.length - 1;
            stream.push({ type: "thinking_start", contentIndex: idx, partial: message });
          }
          thinkingBlock.thinking += d.delta;
          const idx = message.content.indexOf(thinkingBlock);
          stream.push({
            type: "thinking_delta",
            contentIndex: idx,
            delta: d.delta,
            partial: message,
          });
        };

        const onPark = (p: ParkEvent) => {
          if (isDone) return;
          isDone = true;
          cleanupListeners();

          if (verbose) {
            console.error(`[provider-stream] Parked tool call: ${p.toolName} (${p.callId})`);
          }

          // Close text or thinking blocks if active
          if (thinkingBlock) {
            const idx = message.content.indexOf(thinkingBlock);
            stream.push({
              type: "thinking_end",
              contentIndex: idx,
              content: thinkingBlock.thinking,
              partial: message,
            });
            thinkingBlock = null;
          }
          if (textBlock) {
            const idx = message.content.indexOf(textBlock);
            stream.push({
              type: "text_end",
              contentIndex: idx,
              content: textBlock.text,
              partial: message,
            });
            textBlock = null;
          }

          const toolCallBlock: ToolCall = {
            type: "toolCall",
            id: p.callId,
            name: p.toolName,
            arguments: p.args as any,
          };

          message.content.push(toolCallBlock);
          const toolIdx = message.content.length - 1;

          stream.push({ type: "toolcall_start", contentIndex: toolIdx, partial: message });
          stream.push({
            type: "toolcall_delta",
            contentIndex: toolIdx,
            delta: JSON.stringify(p.args),
            partial: message,
          });
          stream.push({
            type: "toolcall_end",
            contentIndex: toolIdx,
            toolCall: toolCallBlock,
            partial: message,
          });

          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
          stream.end(message);
        };

        const onStatusChange = async (ev: { status: string }) => {
          if (isDone) return;
          if (ev.status === "running") {
            hasStarted = true;
            return;
          }

          if (ev.status === "idle") {
            // Ignore idle events before the turn actually started
            if (!hasStarted) {
              return;
            }

            // Only finalize if no tool call is currently parked
            if (roundTrip.hasParkedCalls()) {
              return;
            }

            isDone = true;
            cleanupListeners();

            if (thinkingBlock) {
              const idx = message.content.indexOf(thinkingBlock);
              stream.push({
                type: "thinking_end",
                contentIndex: idx,
                content: thinkingBlock.thinking,
                partial: message,
              });
              thinkingBlock = null;
            }
            if (textBlock) {
              const idx = message.content.indexOf(textBlock);
              stream.push({
                type: "text_end",
                contentIndex: idx,
                content: textBlock.text,
                partial: message,
              });
              textBlock = null;
            }

            // Collect token usage from generator metadata
            try {
              const client = await lsConnection.ensureClient();
              const genMeta = await client.lsClient.getCascadeTrajectoryGeneratorMetadata({
                cascadeId: cascade.cascadeId,
              });
              const gmList = genMeta.generatorMetadata || [];
              if (gmList.length > 0) {
                const latest = gmList[gmList.length - 1];
                if (latest.metadata?.case === "chatModel") {
                  const usage = latest.metadata.value.usage;
                  if (usage) {
                    message.usage.input = Number(usage.inputTokens || 0);
                    message.usage.output = Number(usage.outputTokens || 0);
                    message.usage.cacheRead = Number(usage.cacheReadTokens || 0);
                    message.usage.cacheWrite = Number(usage.cacheWriteTokens || 0);
                    message.usage.totalTokens =
                      message.usage.input + message.usage.output;
                  }
                }
              }
            } catch {
              // ignore usage errors
            }

            // Record turn end for rewind binding BEFORE ending stream
            const currentLeaf = context.messages[context.messages.length - 1] as any;
            if (currentLeaf?.id) {
              await cascadeManager.recordTurnEnd(sessionId, currentLeaf.id, cascade);
            }

            message.stopReason = "stop";
            stream.push({ type: "done", reason: "stop", message });
            stream.end(message);

            // In one-shot print mode (pi -p), cleanup cascade listener so Node can exit cleanly
            const isOneShot =
              process.argv.includes("-p") ||
              process.argv.includes("--print");
            if (isOneShot) {
              setTimeout(() => {
                try {
                  cascade.dispose();
                } catch {
                  // ignore
                }
              }, 200);
            }
          }
        };

        // Attach listeners prior to message dispatch
        cascade.on("text", onText);
        cascade.on("thinking", onThinking);
        cascade.on("statusChange", onStatusChange);
        cascade.on("stepNew", onStepNew);
        roundTrip.on("park", onPark);

        // 3. If the last message was a user message (not just toolResult continuation), send user prompt
        const lastMsg = context.messages[context.messages.length - 1];
        if (lastMsg && lastMsg.role === "user") {
          let userPrompt = "";
          if (typeof lastMsg.content === "string") {
            userPrompt = lastMsg.content;
          } else if (Array.isArray(lastMsg.content)) {
            userPrompt = lastMsg.content
              .filter((b: any) => b.type === "text")
              .map((b: any) => b.text)
              .join("\n");
          }

          if (userPrompt.trim()) {
            const client = await lsConnection.ensureClient();
            if (verbose) {
              console.error(`[provider-stream] Sending message to cascade ${cascade.cascadeId}`);
            }

            await client.lsClient.sendUserCascadeMessage({
              metadata: {
                apiKey: (client as any).apiKey || "",
                ideName: "vscode",
                ideVersion: "1.107.0",
                extensionName: "antigravity",
                extensionVersion: "0.2.0",
              },
              cascadeId: cascade.cascadeId,
              items: [{ chunk: { case: "text", value: userPrompt } }],
              blocking: false,
              clientType: 1,
              cascadeConfig: buildCascadeConfig({
                modelId: numericModelId,
                modelName,
                systemPrompt,
                mcpServerName: mcpServer?.serverName,
              }) as any,
            });
          }
        }

      } catch (err: any) {
        message.stopReason = "error";
        message.errorMessage = err?.message || String(err);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    });

    return stream;
  };
}
