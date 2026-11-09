/**
 * streamSimple implementation for Antigravity LS Provider.
 *
 * Connects pi's streaming tool loop with Antigravity's Cascade agent loop.
 */

import {
  contentText,
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

/** Provider id this extension registers; used to tell "our own" assistant turns apart. */
const PROVIDER_ID = "antigravity-ls";

/** Per-tool-result character budget, mirroring pi's own summarization limits. */
const TOOL_RESULT_MAX_CHARS = 4000;

/**
 * Serializes past messages into a compact transcript for the Language Server.
 *
 * Antigravity keeps its own trajectory, so this transcript only ever carries the
 * history the current Cascade never saw (e.g. turns held with another provider).
 * Thinking blocks are dropped: they are the model's private reasoning and would only
 * burn context. Formatting follows pi's conversation-serialization convention so the
 * model reads the same shapes it already knows from tool results and prompts.
 */
export function formatConversationHistory(
  messages: Array<{ role: string; content?: any; toolName?: string; [key: string]: any }>
): string {
  const parts: string[] = [];

  for (const msg of messages) {
    if (msg.role === "user") {
      const text = contentText(msg.content as any, "").trim();
      if (text) parts.push(`[User]: ${text}`);
      continue;
    }

    if (msg.role === "assistant") {
      const blocks = Array.isArray(msg.content) ? msg.content : [];
      const text = contentText(blocks as any, "").trim();
      if (text) parts.push(`[Assistant]: ${text}`);

      const toolCalls = blocks
        .filter((b: any) => b?.type === "toolCall")
        .map((b: any) => {
          const args = Object.entries(b.arguments ?? {})
            .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
            .join(", ");
          return `${b.name}(${args})`;
        });
      if (toolCalls.length > 0) {
        parts.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const text = contentText(msg.content as any, "").trim();
      if (!text) continue;
      const truncated =
        text.length > TOOL_RESULT_MAX_CHARS
          ? `${text.slice(0, TOOL_RESULT_MAX_CHARS)}\n[truncated]`
          : text;
      const label = msg.toolName ? `Tool result (${msg.toolName})` : "Tool result";
      parts.push(`[${label}]: ${truncated}`);
      continue;
    }

    // role === "system": carried by the pi_system prompt section instead.
  }

  return parts.join("\n\n");
}

export interface PriorHistoryInfo {
  /** Serialized transcript of everything before the current turn ("" when none). */
  priorHistory: string;
  /** True when the previous assistant turn came from a different provider. */
  isExternalSwitch: boolean;
}

/**
 * Stable identifier for the leaf of a turn, used as the rewind-binding key.
 * pi session entries carry `id`, but runtime messages may not; falling back to a
 * positional key keeps rewind tracking working either way.
 */
export function resolveLeafKey(
  leaf: { id?: string; role?: string; timestamp?: number } | undefined,
  messageCount: number
): string {
  if (leaf?.id) return leaf.id;
  if (leaf) {
    return `${leaf.role ?? "unknown"}:${leaf.timestamp ?? 0}:${messageCount}`;
  }
  return `leaf:${messageCount}`;
}

/**
 * Resolves which part of the transcript the Language Server cannot know on its own.
 *
 * A turn starts after the last assistant message, so everything up to and including
 * that assistant message is "prior history". When the last assistant message came from
 * another provider, our Cascade can never have observed the turns in between: the
 * whole prefix has to be replayed and the Cascade restarted.
 */
export function resolvePriorHistory(
  messages: Array<{ role: string; provider?: string; content?: any; [key: string]: any }>
): PriorHistoryInfo {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  if (lastAssistantIndex < 0) {
    return { priorHistory: "", isExternalSwitch: false };
  }

  const lastAssistant = messages[lastAssistantIndex];
  const isExternalSwitch = typeof lastAssistant.provider === "string" && lastAssistant.provider !== PROVIDER_ID;
  const priorHistory = formatConversationHistory(messages.slice(0, lastAssistantIndex + 1));

  return { priorHistory, isExternalSwitch };
}

/**
 * Extracts all new user prompt texts for the current turn.
 * If the current turn contains toolResult messages, returns an empty array (tool continuation).
 */
export function extractTurnUserPrompts(
  messages: Array<{ role: string; content?: any }>
): string[] {
  let lastAssistantIndex = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const turnMessages = messages.slice(lastAssistantIndex + 1);

  // If the turn contains toolResult messages, this turn is a continuation of a parked tool call.
  // The cascade is already resuming via MCP tool resolution; do NOT send another user message.
  const hasToolResult = turnMessages.some((msg) => msg.role === "toolResult");
  if (hasToolResult) {
    return [];
  }

  const userTexts: string[] = [];
  for (const msg of turnMessages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string") {
        const trimmed = msg.content.trim();
        if (trimmed) userTexts.push(trimmed);
      } else if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((b: any) => b.type === "text" && b.text)
          .map((b: any) => b.text.trim())
          .join("\n");
        if (text) userTexts.push(text);
      }
    }
  }

  return userTexts;
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

        // Resolve what the Language Server cannot know on its own: history from turns
        // that happened before this Cascade existed (e.g. on another provider).
        const { priorHistory, isExternalSwitch } = resolvePriorHistory(context.messages as any);

        // Get or synchronize the turn's Cascade
        const turn = await cascadeManager.ensureTurnCascade({
          sessionId,
          branch: context.messages as any,
          modelId: numericModelId,
          modelName,
          systemPrompt,
          mcpServerName: mcpServer?.serverName,
          priorHistory,
          isExternalSwitch,
        });
        const cascade = turn.cascade;

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

            // Record turn end for rewind binding BEFORE ending stream.
            // pi's runtime messages do not always carry an `id` (only session entries do),
            // so fall back to a stable positional key; otherwise rewind tracking silently
            // stops recording anything after the first id-less turn.
            const currentLeaf = context.messages[context.messages.length - 1] as any;
            const leafKey = resolveLeafKey(currentLeaf, context.messages.length);
            await cascadeManager.recordTurnEnd(sessionId, leafKey, cascade);

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

        // 3. Collect new user messages in the current turn and send prompts sequentially (D-01, D-02, D-03)
        const userTexts = extractTurnUserPrompts(context.messages as any);

        if (userTexts.length > 0) {
          const client = await lsConnection.ensureClient();

          // pi may have changed its active tool set mid-session (plan mode, tool_search,
          // --tools modifiers). Re-publish the MCP tool catalog so the LS schema matches.
          if (mcpServer?.consumeToolSetChanged()) {
            try {
              await client.refreshMcpServers();
              if (verbose) {
                console.error(`[provider-stream] Active tool set changed; refreshed MCP servers`);
              }
            } catch {
              // a stale tool schema is recoverable; never fail the turn for it
            }
          }

          const cascadeConfig = buildCascadeConfig({
            modelId: numericModelId,
            modelName,
            systemPrompt,
            mcpServerName: mcpServer?.serverName,
            // History the Cascade never saw: empty while it continues normally, since
            // its own trajectory already holds those turns.
            conversationHistory: turn.priorHistory,
          }) as any;

          // Send each user message sequentially to create distinct USER_INPUT steps in the trajectory (D-03)
          for (let i = 0; i < userTexts.length; i++) {
            const prompt = userTexts[i];
            if (verbose) {
              console.error(
                `[provider-stream] Sending message ${i + 1}/${userTexts.length} to cascade ${cascade.cascadeId}: ${prompt.slice(0, 60)}...`
              );
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
              items: [{ chunk: { case: "text", value: prompt } }],
              blocking: false,
              clientType: 1,
              cascadeConfig,
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
