/**
 * CascadeConfig builder for pi-antigravity-ls-provider.
 *
 * Configures the Antigravity planner to:
 * - Direct model to use pi-tools MCP tools via call_mcp_tool
 * - Explicitly prohibit built-in tools (read_file, write_file, edit_file, run_command)
 * - Retain mcp_servers prompt section while removing other built-in instructions
 */

export const BUILTIN_PROMPT_SECTIONS = [
  "identity",
  "terminal_sandbox",
  "artifacts",
  "conversation_transcript",
  "guidelines",
  "communication_style",
  "slash_commands",
  "messaging",
  "subagents",
  "skills",
  "user_information",
  // Note: "mcp_servers" is intentionally NOT removed so the model sees the registered MCP tools.
] as const;

export const PI_TOOLS_DIRECTIVE = `
# CRITICAL TOOL USE DIRECTIVE:
You are operating as an AI coding assistant inside the pi coding agent harness.
All Antigravity built-in tools (read_file, write_file, edit_file, run_command) are STRICTLY DISABLED and will be rejected.
You MUST strictly use the tools provided by the "pi-tools" MCP server via call_mcp_tool:
- To inspect directories or find files: use call_mcp_tool with ServerName: "pi-tools", ToolName: "bash" or "find" / "ls".
- To read file contents: use call_mcp_tool with ServerName: "pi-tools", ToolName: "read", Arguments: { "path": "/path/to/file" }.
- To write files: use call_mcp_tool with ServerName: "pi-tools", ToolName: "write", Arguments: { "path": "/path/to/file", "content": "..." }.
- To edit files: use call_mcp_tool with ServerName: "pi-tools", ToolName: "edit", Arguments: { "path": "/path/to/file", "edits": [...] }.
- To run shell commands: use call_mcp_tool with ServerName: "pi-tools", ToolName: "bash", Arguments: { "command": "..." }.

When asked about a project, path, or codebase (e.g. @Projects/...), you MUST call pi-tools (read/bash/find) to examine the actual filesystem before answering. NEVER answer from training memory alone without reading the files first!
`;

export interface CascadeConfigOptions {
  modelId: number;
  modelName?: string;
  systemPrompt: string;
}

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, modelName, systemPrompt } = options;

  const combinedPrompt = [
    PI_TOOLS_DIRECTIVE,
    systemPrompt || "You are an expert AI software engineer operating as a coding agent.",
  ].join("\n\n");

  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "conversational" as const,
        value: { plannerMode: 1 },
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
      promptSectionCustomizationConfig: {
        removePromptSections: [...BUILTIN_PROMPT_SECTIONS],
        appendPromptSections: [
          {
            title: "pi_system",
            content: combinedPrompt,
          },
        ],
      },
      toolConfig: {
        runCommand: { forceDisable: true },
        code: { forceDisable: true },
        mquery: { forceDisable: true },
        searchWeb: { forceDisable: true },
        memory: { forceDisable: true },
        generateImage: { forceDisable: true },
        suggestedResponse: { forceDisable: true },
        trajectorySearch: { forceDisable: true },
        invokeSubagent: { enabled: false },
        antigravityBrowser: { enabled: false },
        notebookEdit: { enabled: false },
        askQuestion: { enabled: false },
        readKnowledgeBaseItem: { enabled: false },
        disableSimpleResearchTools: true,
        // mcp is kept enabled for pi tools
      },
    },
  };
}
