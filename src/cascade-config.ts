/**
 * CascadeConfig builder for pi-antigravity-ls-provider.
 *
 * Configures the Antigravity planner to:
 * - Disable all builtin tools (forceDisable / enabled: false)
 * - Remove all 11 default prompt sections and inject pi's system prompt
 * - Request the specified model
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
] as const;

export interface CascadeConfigOptions {
  modelId: number;
  systemPrompt: string;
}

export function buildCascadeConfig(options: CascadeConfigOptions) {
  const { modelId, systemPrompt } = options;

  return {
    plannerConfig: {
      plannerTypeConfig: {
        case: "conversational" as const,
        value: { plannerMode: 1 },
      },
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
            content: systemPrompt || "You are an AI coding assistant.",
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
