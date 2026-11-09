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
}

const FALLBACK_SYSTEM_PROMPT =
  "You are an expert AI software engineer operating as a coding agent.";

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, modelName, systemPrompt, mcpServerName } = options;
  const targetProviderName = mcpServerName || "pi-tools";

  const promptContent = systemPrompt || FALLBACK_SYSTEM_PROMPT;

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
          promptSections: [
            {
              item: {
                case: "custom" as const,
                value: {
                  title: "pi_system",
                  content: promptContent,
                },
              },
            },
          ],
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
