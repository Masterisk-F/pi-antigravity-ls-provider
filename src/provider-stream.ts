/**
 * streamSimple implementation for Antigravity LS Provider.
 *
 * Connects pi's streaming tool loop with Antigravity's Cascade agent loop.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { getPackageDir } from "@earendil-works/pi-coding-agent";
import {
  contentText,
  getCurrentSystemMessage,
  getSystemMessageText,
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
import { type LsConnection, ANTIGRAVITY_IDE_VERSION } from "./ls-connection.js";
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

const DEFAULT_SYSTEM_PROMPT =
  "You are an expert coding assistant. You help users by reading files, executing commands, editing code, and writing new files.";

export const NORMALIZED_PREAMBLE =
  "You are Antigravity, a powerful agentic AI coding assistant designed by Google DeepMind. Your harness is pi coding agent. You help users by reading files, executing commands, editing code, and writing new files.";

let cachedDefaultPiPreambles: Promise<string[]> | undefined;

function collectPiPackageDirs(): string[] {
  const dirs = new Set<string>();
  try {
    dirs.add(fs.realpathSync(getPackageDir()));
  } catch {
    dirs.add(getPackageDir());
  }

  // When loaded as an ESM package inside a host `pi` process whose version differs
  // from local `node_modules/@earendil-works/pi-coding-agent`, Node's native ESM
  // resolution follows local `node_modules` instead of jiti's host alias. Walk up
  // from `process.argv[1]` as well so the running host pi package is included.
  const entry = process.argv[1];
  if (entry) {
    try {
      let dir = path.dirname(fs.realpathSync(entry));
      while (dir !== path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, "dist", "core", "system-prompt.js"))) {
          dirs.add(dir);
          break;
        }
        dir = path.dirname(dir);
      }
    } catch {
      // ignore invalid or virtual entry paths
    }
  }

  return [...dirs];
}

/**
 * Loads pi's built-in default preamble strings directly from the imported
 * `@earendil-works/pi-coding-agent` package (and the active host `pi` package
 * when different) so we never hardcode version-specific prompt strings.
 */
function resolveDefaultPiPreambles(): Promise<string[]> {
  if (!cachedDefaultPiPreambles) {
    cachedDefaultPiPreambles = (async () => {
      const preambles = new Set<string>();
      for (const pkgDir of collectPiPackageDirs()) {
        try {
          const modPath = path.join(pkgDir, "dist", "core", "system-prompt.js");
          const mod = await import(pathToFileURL(modPath).href);
          const preamble = mod?.buildSystemPromptSections?.({ cwd: "." })?.preamble;
          if (typeof preamble === "string" && preamble.length > 0) {
            preambles.add(preamble);
          }
        } catch {
          // ignore unreadable or incompatible package layouts
        }
      }
      return [...preambles];
    })();
  }
  return cachedDefaultPiPreambles;
}

/**
 * Resolves the effective system prompt from transcript messages.
 *
 * When pi's structured `sections.preamble` is present, replaces `sections.preamble`
 * directly with {@link NORMALIZED_PREAMBLE} while keeping all other sections intact.
 * When `sections` is absent (for example, Pi's `forceSystemPrompt` projection when
 * extensions return `{ systemPrompt }` from `before_agent_start`), locates pi's
 * package-defined default preamble inside the flattened `content` and replaces it
 * with {@link NORMALIZED_PREAMBLE}.
 */
export async function extractSystemPrompt(
  messages: readonly { role: string; content?: any; sections?: Record<string, string | null | undefined>; [key: string]: any }[]
): Promise<string> {
  let systemPrompt = "";
  try {
    const systemMsg = getCurrentSystemMessage(messages as any);
    if (systemMsg) {
      if (typeof systemMsg.sections?.preamble === "string") {
        const patchedMsg = {
          ...systemMsg,
          sections: {
            ...systemMsg.sections,
            preamble: NORMALIZED_PREAMBLE,
          },
        };
        return getSystemMessageText(patchedMsg).trim() || DEFAULT_SYSTEM_PROMPT;
      }
      systemPrompt = getSystemMessageText(systemMsg).trim();
    }
  } catch {
    // ignore error and fallback
  }

  if (!systemPrompt) {
    for (const msg of messages) {
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
  }

  if (!systemPrompt) {
    return DEFAULT_SYSTEM_PROMPT;
  }

  for (const defaultPreamble of await resolveDefaultPiPreambles()) {
    if (systemPrompt.includes(defaultPreamble)) {
      return systemPrompt.replace(defaultPreamble, NORMALIZED_PREAMBLE);
    }
  }
  return systemPrompt;
}

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
      const text = msg.content != null ? contentText(msg.content as any, "").trim() : "";
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
      const text = msg.content != null ? contentText(msg.content as any, "").trim() : "";
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
  let historyEndIndex = lastAssistantIndex + 1;
  while (
    historyEndIndex < messages.length &&
    messages[historyEndIndex].role === "toolResult"
  ) {
    historyEndIndex++;
  }
  const priorHistory = formatConversationHistory(messages.slice(0, historyEndIndex));

  return { priorHistory, isExternalSwitch };
}

/**
 * Extracts all new user prompt texts for the current turn.
 * Collects all user messages appearing after the most recent assistant message.
 * In a normal tool continuation turn, turnMessages contains only toolResult messages,
 * so userTexts naturally evaluates to an empty array.
 * When a tool terminates the turn (e.g. plannotator_submit_plan returning `terminate: true`)
 * or after an aborted tool, any subsequent user messages are extracted and sent to LS. (D-01)
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

      let isDone = false;
      let cleanupListeners: () => void = () => {};

      try {
        await options?.onResponse?.({ status: 200, headers: {} }, model);
        stream.push({ type: "start", partial: message });

        const { numericId: numericModelId, modelName } = modelCatalog.resolveModel(
          model.id,
          options?.reasoning
        );

        // Extract system prompt with support for structured sections and mid-conversation patches (D-04)
        const systemPrompt = await extractSystemPrompt(context.messages as any);

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
        let hasStarted = false;
        let timeoutTimer: NodeJS.Timeout | null = null;

        const clearTurnTimeout = () => {
          if (timeoutTimer) {
            clearTimeout(timeoutTimer);
            timeoutTimer = null;
          }
        };

        const resetTurnTimeout = (ms = 120000) => {
          clearTurnTimeout();
          timeoutTimer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            cleanupListeners();
            cascade.cancel().catch(() => {});
            roundTrip.abortAll("Turn timed out");
            message.stopReason = "error";
            message.errorMessage = "Antigravity LS response timed out after 120s of inactivity.";
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
          }, ms);
          timeoutTimer?.unref?.();
        };

        cleanupListeners = () => {
          clearTurnTimeout();
          cascade.off("text", onText);
          cascade.off("thinking", onThinking);
          cascade.off("statusChange", onStatusChange);
          cascade.off("stepNew", onStepNew);
          roundTrip.off("park", onPark);
          signal?.removeEventListener("abort", onAbort);
          (lsConnection as any).off?.("exit", onLsExit);
          (lsConnection as any).off?.("disconnect", onLsExit);
        };

        const onLsExit = (info?: { code?: number | null; signal?: string | null }) => {
          if (isDone) return;
          if (verbose) {
            console.error(
              `[provider-stream] LS process exit/disconnect detected during turn: code=${info?.code}, signal=${info?.signal}`
            );
          }
          isDone = true;
          cleanupListeners();
          cascade.cancel().catch(() => {});
          roundTrip.abortAll("Antigravity LS process exited unexpectedly");
          message.stopReason = "error";
          message.errorMessage = `Antigravity LS process exited unexpectedly${
            info?.code !== undefined ? ` (code=${info?.code}, signal=${info?.signal})` : "."
          }`;
          stream.push({ type: "error", reason: "error", error: message });
          stream.end(message);
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

        const onStepNew = (ev: any) => {
          hasStarted = true;
          resetTurnTimeout();

          // Catch Antigravity LS execution errors (e.g. CORTEX_STEP_TYPE_ERROR_MESSAGE, type=17) (D-02)
          if (ev?.step?.type === "errorMessage" || ev?.step?.type === 17) {
            const raw = ev.step.raw;
            const rawErr = raw?.step?.value?.error || raw?.errorMessage?.error;
            const errMsg =
              rawErr?.userErrorMessage ||
              rawErr?.shortError ||
              "Agent execution terminated due to error.";

            if (verbose) {
              console.error(`[provider-stream] LS error message step detected: ${errMsg}`);
            }

            if (isDone) return;
            isDone = true;
            cleanupListeners();

            message.stopReason = "error";
            message.errorMessage = errMsg;
            stream.push({ type: "error", reason: "error", error: message });
            stream.end(message);
          }
        };

        const onText = (d: { delta: string; fullText?: string }) => {
          if (isDone) return;
          hasStarted = true;
          resetTurnTimeout();
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
          resetTurnTimeout();
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

        const onPark = async (p: ParkEvent) => {
          if (isDone) return;
          isDone = true;
          cleanupListeners();

          if (verbose) {
            console.error(`[provider-stream] Parked tool call: ${p.toolName} (${p.callId})`);
          }

          clearTurnTimeout();

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

          // Record intermediate toolCall step index and upcoming toolResult step index in CascadeManager (D-01)
          await cascadeManager.recordToolCallStep(
            sessionId,
            context.messages as any,
            message as any,
            p.callId,
            cascade
          );

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

            // Check if model terminated abnormally without producing any text or thinking blocks (D-03)
            // (e.g. unknown model key in LS executor, quota rejection, or executor failure)
            if (!textBlock && !thinkingBlock) {
              try {
                const client = await lsConnection.ensureClient();
                const history = await client.lsClient.getCascadeTrajectory({ cascadeId: cascade.cascadeId });
                const steps = history.trajectory?.steps || [];
                const errStep = steps.find(
                  (s: any) => s.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" || s.type === 17 || s.step?.case === "errorMessage"
                );
                if (errStep) {
                  const errorObj = (errStep as any).errorMessage?.error || (errStep as any).step?.value?.error;
                  const errMsg =
                    errorObj?.shortError ||
                    errorObj?.userErrorMessage ||
                    errorObj?.modelErrorMessage ||
                    "Language Server execution terminated due to error";
                  message.stopReason = "error";
                  message.errorMessage = errMsg;
                  stream.push({ type: "error", reason: "error", error: message });
                  stream.end(message);
                  return;
                }
              } catch {
                // fall through to normal completion if trajectory inspection fails
              }
            }

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
            await cascadeManager.recordTurnEnd(sessionId, leafKey, cascade, {
              branch: context.messages as any,
              assistantMessage: message as any,
            });

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
        (lsConnection as any).once?.("exit", onLsExit);
        (lsConnection as any).once?.("disconnect", onLsExit);

        // Deliver tool results to Language Server now that all listeners are active (D-01):
        // 1. Flush any results staged by pi.on("tool_result")
        roundTrip.flushStagedResults();

        // 2. Resolve from context.messages if any result was not staged (e.g. in test suites or direct calls)
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

        // 3. Collect new user messages in the current turn and send prompts sequentially (D-01, D-02, D-03).
        // If this is a tool-continuation turn (userTexts empty) AND a brand new Cascade was created
        // (e.g. LS restarted mid-tool-loop or external provider switch), dispatch a continuation prompt
        // so the fresh Cascade receives cascadeConfig (including full priorHistory) and resumes work.
        const userTexts = extractTurnUserPrompts(context.messages as any);
        const promptsToSend =
          userTexts.length > 0
            ? userTexts
            : turn.isFreshCascade
              ? ["Continue based on the tool execution results above."]
              : [];

        if (promptsToSend.length > 0) {
          const client = await lsConnection.ensureClient();

          // Ensure MCP server is properly registered in config before dispatching prompts (D-01: Self-Healing)
          if (mcpServer) {
            await mcpServer.ensureRegistered(client);
          }

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
          for (let i = 0; i < promptsToSend.length; i++) {
            if (isDone) break;
            const prompt = promptsToSend[i];
            if (verbose) {
              console.error(
                `[provider-stream] Sending message ${i + 1}/${promptsToSend.length} to cascade ${cascade.cascadeId}: ${prompt.slice(0, 60)}...`
              );
            }

            await client.lsClient.sendUserCascadeMessage({
              metadata: {
                apiKey: (client as any).apiKey || "",
                ideName: "vscode",
                ideVersion: ANTIGRAVITY_IDE_VERSION,
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

          // Mark turn started and arm timeout now that messages have been sent (D-03, D-04)
          hasStarted = true;
          resetTurnTimeout();
        } else {
          // Tool continuation turn: LS is already executing based on resolved MCP tool result (D-01)
          hasStarted = true;
          resetTurnTimeout();

          // Guard against already-idle or aborted cascade (D-03):
          // If cascade is already idle with no active generation and no parked calls,
          // check if an error occurred in LS trajectory rather than hanging for 120s.
          if ((cascade.state.status as any) === "idle" || (cascade.state.status as any) === 1) {
            queueMicrotask(async () => {
              if (isDone) return;
              try {
                const client = await lsConnection.ensureClient();
                const history = await client.lsClient.getCascadeTrajectory({ cascadeId: cascade.cascadeId });
                const steps = history.trajectory?.steps || [];
                const lastStep = steps.length > 0 ? steps[steps.length - 1] : null;
                const errStep = steps.find(
                  (s: any) => s.type === "CORTEX_STEP_TYPE_ERROR_MESSAGE" || s.type === 17 || s.step?.case === "errorMessage"
                );
                if (errStep || (lastStep && ((lastStep as any).status === 7 || (lastStep as any).status === "CORTEX_STEP_STATUS_ERROR"))) {
                  const errorObj = (errStep as any)?.errorMessage?.error || (errStep as any)?.step?.value?.error || (lastStep as any)?.error;
                  const errMsg =
                    errorObj?.userErrorMessage ||
                    errorObj?.shortError ||
                    errorObj?.modelErrorMessage ||
                    "Language Server execution terminated prematurely.";
                  if (isDone) return;
                  isDone = true;
                  cleanupListeners();
                  message.stopReason = "error";
                  message.errorMessage = errMsg;
                  stream.push({ type: "error", reason: "error", error: message });
                  stream.end(message);
                }
              } catch {
                // ignore
              }
            });
          }
        }

      } catch (err: any) {
        cleanupListeners();
        if (isDone) return;
        isDone = true;
        message.stopReason = "error";
        message.errorMessage = err?.message || String(err);
        stream.push({ type: "error", reason: "error", error: message });
        stream.end(message);
      }
    });

    return stream;
  };
}
