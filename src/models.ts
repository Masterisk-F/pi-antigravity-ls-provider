/**
 * Model catalog for Antigravity LS Provider.
 * Includes Gemini 3.8 Flash (Low, Medium, High) and the full production model suite.
 */

export interface AntigravityModelDefinition {
  id: string;
  name: string;
  numericId: number;
  modelName?: string;
  type: "chat";
  reasoning: boolean;
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

export const ANTIGRAVITY_LS_MODELS: AntigravityModelDefinition[] = [
  {
    id: "Gemini_3_8_Flash_Low",
    name: "Gemini 3.8 Flash (Low)",
    numericId: 1322,
    modelName: "gemini-3.8-flash-low",
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_3_8_Flash_Medium",
    name: "Gemini 3.8 Flash (Medium)",
    numericId: 1322,
    modelName: "gemini-3.8-flash-medium",
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_3_8_Flash_High",
    name: "Gemini 3.8 Flash (High)",
    numericId: 1322,
    modelName: "gemini-3.8-flash-high",
    type: "chat",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
  },
  {
    id: "Gemini_3_8_Flash",
    name: "Gemini 3.8 Flash (Medium default)",
    numericId: 1322,
    modelName: "gemini-3.8-flash-medium",
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
      this.modelMap.set(m.id.toLowerCase(), m);
      this.modelMap.set(m.id.replace(/_/g, "-"), m);
    }
  }

  getModels(): AntigravityModelDefinition[] {
    return ANTIGRAVITY_LS_MODELS;
  }

  resolveModel(idOrKey: string): { numericId: number; modelName?: string } {
    const normalized = idOrKey.replace(/^antigravity-ls\//, "");
    const found =
      this.modelMap.get(idOrKey) ||
      this.modelMap.get(normalized) ||
      this.modelMap.get(normalized.toLowerCase());

    if (found) {
      return { numericId: found.numericId, modelName: found.modelName };
    }

    // Default to Gemini 3.8 Flash Medium
    return { numericId: 1322, modelName: "gemini-3.8-flash-medium" };
  }

  resolveNumericModelId(idOrKey: string): number {
    return this.resolveModel(idOrKey).numericId;
  }
}
