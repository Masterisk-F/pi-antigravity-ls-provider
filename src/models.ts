/**
 * Model catalog for Antigravity LS Provider.
 * Includes Gemini 3.8 Flash and the full production model suite.
 */

export interface AntigravityModelDefinition {
  id: string;
  name: string;
  numericId: number;
  type: "chat";
  reasoning: boolean;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const ANTIGRAVITY_LS_MODELS: AntigravityModelDefinition[] = [
  {
    id: "Gemini_3_8_Flash",
    name: "Gemini 3.8 Flash",
    numericId: 1322,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_4_Argon_Low",
    name: "Gemini 4 Argon (Low)",
    numericId: 1419,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_4_Argon_Medium",
    name: "Gemini 4 Argon (Medium)",
    numericId: 1418,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_4_Argon_High",
    name: "Gemini 4 Argon (High)",
    numericId: 1417,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Sonnet_5_5_High",
    name: "Claude Sonnet 5.5 (High)",
    numericId: 1405,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Sonnet_5_5_Medium",
    name: "Claude Sonnet 5.5 (Medium)",
    numericId: 1404,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Sonnet_5_5_Low",
    name: "Claude Sonnet 5.5 (Low)",
    numericId: 1403,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Opus_5_5_High",
    name: "Claude Opus 5.5 (High)",
    numericId: 1402,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Opus_5_5_Medium",
    name: "Claude Opus 5.5 (Medium)",
    numericId: 1401,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "Claude_Opus_5_5_Low",
    name: "Claude Opus 5.5 (Low)",
    numericId: 1400,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
  },
  {
    id: "GPT_OSS_120B_Medium",
    name: "GPT-OSS 120B (Medium)",
    numericId: 342,
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131000,
    maxTokens: 32000,
  },
];

export class ModelCatalog {
  private modelMap = new Map<string, AntigravityModelDefinition>();

  constructor() {
    for (const m of ANTIGRAVITY_LS_MODELS) {
      this.modelMap.set(m.id, m);
      this.modelMap.set(`antigravity-ls/${m.id}`, m);
      // also alias with dashes
      this.modelMap.set(m.id.replace(/_/g, "-"), m);
    }
  }

  getModels(): AntigravityModelDefinition[] {
    return ANTIGRAVITY_LS_MODELS;
  }

  resolveNumericModelId(idOrKey: string): number {
    const found = this.modelMap.get(idOrKey);
    if (found) return found.numericId;

    // Check alias
    const normalized = idOrKey.replace(/^antigravity-ls\//, "");
    const aliased = this.modelMap.get(normalized);
    if (aliased) return aliased.numericId;

    // Default to Gemini 3.8 Flash
    return 1322;
  }
}
