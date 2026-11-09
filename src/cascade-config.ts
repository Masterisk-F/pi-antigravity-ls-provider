/**
 * CascadeConfig builder for pi-antigravity-ls-provider.
 *
 * Uses Antigravity's declarativeMixinConfig to:
 * - Completely exclude all Antigravity built-in tools (read_file, write_file, edit_file, run_command) from the tool schema
 * - Expose ONLY pi-tools (read, write, edit, bash, and installed pi extensions) as native tool schemas
 * - Inject only pi's system prompt (no default Antigravity boilerplate prompts)
 */

export interface CascadeConfigOptions {
  modelId: number;
  modelName?: string;
  systemPrompt: string;
}

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, modelName, systemPrompt } = options;

  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "declarativeMixinConfig" as const,
        value: {
          // Whitelist ONLY tools from "pi-tools" MCP server.
          // Built-in tools (read_file, run_command, etc.) are NOT in this list,
          // so the Language Server never includes them in the model's function schema!
          tools: [
            {
              match: { case: "pattern" as const, value: ".*" },
              source: { case: "providerName" as const, value: "pi-tools" },
            },
          ],
          promptSections: [
            {
              item: {
                case: "custom" as const,
                value: {
                  title: "pi_system",
                  content: systemPrompt || "You are an expert AI software engineer operating as a coding agent.",
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
