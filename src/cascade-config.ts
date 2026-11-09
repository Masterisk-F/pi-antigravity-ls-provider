/**
 * CascadeConfig builder for pi-antigravity-ls-provider.
 *
 * Uses Antigravity's declarativeMixinConfig to:
 * - Completely exclude all Antigravity built-in tools (read_file, write_file, edit_file, run_command) from the tool schema
 * - Expose ONLY pi-tools (read, write, edit, bash, and active pi tools) as native tool schemas
 * - Inject optimized pi tool directives preventing redundant tool churn and non-existent tool calls
 */

export interface CascadeConfigOptions {
  modelId: number;
  modelName?: string;
  systemPrompt: string;
}

export const PI_TOOLS_DIRECTIVE = `
# CRITICAL TOOL USE DIRECTIVE:
You are operating inside the pi coding agent harness.
All Antigravity built-in tools (read_file, write_file, edit_file, run_command) are STRICTLY DISABLED and will fail.
You MUST strictly use the tools provided by pi:
- To inspect directories or search files: use the "bash" tool with standard Linux commands (e.g. ls, find). Do NOT call non-existent "ls" or "find" tools directly!
- To read file contents: use the "read" tool with { "path": "..." }. Read only the essential files (e.g. README, package.json, entrypoint) needed to answer efficiently. Avoid reading dozens of files in a loop.
- To write files: use the "write" tool with { "path": "...", "content": "..." }.
- To edit files: use the "edit" tool with { "path": "...", "edits": [...] }.
- To run terminal commands: use the "bash" tool with { "command": "..." }.

When asked about a project or codebase, inspect the key directory structure with "bash" (ls) and read the 1-2 most relevant files with "read", then synthesize your answer promptly without excessive back-and-forth tool calls.
`;

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, modelName, systemPrompt } = options;

  const combinedPrompt = [
    PI_TOOLS_DIRECTIVE,
    systemPrompt || "You are an expert AI software engineer operating as a coding agent.",
  ].join("\n\n");

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
                  content: combinedPrompt,
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
