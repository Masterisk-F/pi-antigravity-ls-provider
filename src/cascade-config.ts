/**
 * CascadeConfig builder for pi-antigravity-ls-provider.
 *
 * Uses Antigravity's declarativeMixinConfig to:
 * - Completely exclude all Antigravity built-in tools (read_file, write_file, edit_file, run_command) from the tool schema
 * - Expose ONLY pi-tools (active pi tools) as native tool schemas
 * - Pass pi's own system prompt through unchanged (no extra directives)
 */

export interface CascadeConfigOptions {
  modelId: number;
  modelName?: string;
  systemPrompt: string;
  mcpServerName?: string;
  /**
   * Transcript of turns that happened before the current Cascade existed
   * (for example, a conversation held with another provider before the model
   * was switched to this one). Antigravity LS keeps its own trajectory, so only
   * the history it never saw has to be replayed here.
   */
  conversationHistory?: string;
}

const FALLBACK_SYSTEM_PROMPT =
  "You are an expert AI software engineer operating as a coding agent.";

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, modelName, systemPrompt, mcpServerName, conversationHistory } = options;
  const targetProviderName = mcpServerName || "pi-tools";

  const promptContent = systemPrompt || FALLBACK_SYSTEM_PROMPT;

  const promptSections: Array<{
    item: {
      case: "custom";
      value: { title: string; content: string };
    };
  }> = [
    {
      item: {
        case: "custom" as const,
        value: {
          title: "pi_system",
          content: promptContent,
        },
      },
    },
  ];

  // Only inject when there actually is history the Language Server never saw;
  // an empty section would just burn context for nothing.
  if (conversationHistory && conversationHistory.trim().length > 0) {
    promptSections.push({
      item: {
        case: "custom" as const,
        value: {
          title: "conversation_history",
          content:
            "The following is the conversation history from prior turns before switching to this model. " +
            "Use this context to understand previous questions, tool executions, decisions, and instructions:\n\n" +
            conversationHistory,
        },
      },
    });
  }

  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "declarativeMixinConfig" as const,
        value: {
          // Whitelist ONLY tools from the instance's dedicated MCP server.
          // Built-in tools (read_file, run_command, etc.) are NOT in this list,
          // so the Language Server never includes them in the model's function schema!
          tools: [
            {
              match: { case: "pattern" as const, value: ".*" },
              source: { case: "providerName" as const, value: targetProviderName },
            },
          ],
          promptSections,
        },
      },
      modelName: modelName || "",
      requestedModel: {
        choice: {
          case: "model" as const,
          value: modelId,
        },
      },
      noToolExplanation: true,
      noToolSummary: true,
    },
  };
}
