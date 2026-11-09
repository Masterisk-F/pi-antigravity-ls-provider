/**
 * Model catalog for Antigravity LS Provider.
 *
 * Exposes unified models with effort tiers mapped via thinkingLevelMap:
 * - gemini-3.8-flash (effort: low, medium, high)
 * - gemini-4-argon   (effort: low, medium, high)
 * - claude-sonnet-5-5 (effort: low, medium, high)
 * - claude-opus-5-5   (effort: low, medium, high)
 * - gpt-oss-120b      (single tier)
 */

export type EffortTier = "low" | "medium" | "high";

export interface AntigravityModelDefinition {
  id: string;
  name: string;
  type: "chat";
  reasoning: boolean;
  thinkingLevelMap?: {
    off?: null;
    minimal?: string | null;
    low?: string | null;
    medium?: string | null;
    high?: string | null;
    xhigh?: string | null;
    max?: string | null;
  };
  input: ["text"];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  resolveTier: (effort?: string) => { numericId: number; modelName?: string };
}

const THREE_TIER_MAP = {
  off: null,
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "high",
  max: "high",
} as const;

export const ANTIGRAVITY_LS_MODELS: AntigravityModelDefinition[] = [
  {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    type: "chat",
    reasoning: true,
    thinkingLevelMap: THREE_TIER_MAP,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
    resolveTier: (effort) => {
      const e = normalizeEffort(effort);
      return {
        numericId: 1322,
        modelName: `gemini-3.8-flash-${e}`,
      };
    },
  },
  {
    id: "gemini-4-argon",
    name: "Gemini 4 Argon",
    type: "chat",
    reasoning: true,
    thinkingLevelMap: THREE_TIER_MAP,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000000,
    maxTokens: 64000,
    resolveTier: (effort) => {
      const e = normalizeEffort(effort);
      const idMap: Record<EffortTier, number> = {
        low: 1419,
        medium: 1418,
        high: 1417,
      };
      return {
        numericId: idMap[e],
        modelName: `gemini-4-argon-${e}`,
      };
    },
  },
  {
    id: "claude-sonnet-5-5",
    name: "Claude Sonnet 5.5",
    type: "chat",
    reasoning: true,
    thinkingLevelMap: THREE_TIER_MAP,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    resolveTier: (effort) => {
      const e = normalizeEffort(effort);
      const idMap: Record<EffortTier, number> = {
        low: 1403,
        medium: 1404,
        high: 1405,
      };
      return {
        numericId: idMap[e],
        modelName: `claude-sonnet-5-5-${e}`,
      };
    },
  },
  {
    id: "claude-opus-5-5",
    name: "Claude Opus 5.5",
    type: "chat",
    reasoning: true,
    thinkingLevelMap: THREE_TIER_MAP,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 64000,
    resolveTier: (effort) => {
      const e = normalizeEffort(effort);
      const idMap: Record<EffortTier, number> = {
        low: 1400,
        medium: 1401,
        high: 1402,
      };
      return {
        numericId: idMap[e],
        modelName: `claude-opus-5-5-${e}`,
      };
    },
  },
  {
    id: "gpt-oss-120b",
    name: "GPT-OSS 120B",
    type: "chat",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 131000,
    maxTokens: 32000,
    resolveTier: () => ({
      numericId: 342,
      modelName: "gpt-oss-120b-medium",
    }),
  },
];

function normalizeEffort(effort?: string): EffortTier {
  if (!effort) return "medium";
  const lower = effort.toLowerCase();
  if (lower === "low" || lower === "minimal") return "low";
  if (lower === "high" || lower === "xhigh" || lower === "max") return "high";
  return "medium";
}

export class ModelCatalog {
  private modelMap = new Map<string, AntigravityModelDefinition>();

  constructor() {
    for (const m of ANTIGRAVITY_LS_MODELS) {
      this.modelMap.set(m.id, m);
      this.modelMap.set(`antigravity-ls/${m.id}`, m);
      // Legacy underscore aliases
      this.modelMap.set(m.id.replace(/-/g, "_"), m);
      this.modelMap.set(m.id.replace(/\./g, "_").replace(/-/g, "_"), m);
    }
  }

  getModels(): AntigravityModelDefinition[] {
    return ANTIGRAVITY_LS_MODELS;
  }

  resolveModel(idOrKey: string, effort?: string): { numericId: number; modelName?: string } {
    const clean = idOrKey.replace(/^antigravity-ls\//, "");
    const found =
      this.modelMap.get(idOrKey) ||
      this.modelMap.get(clean) ||
      this.modelMap.get(clean.toLowerCase());

    if (found) {
      return found.resolveTier(effort);
    }

    // Default to Gemini 3.8 Flash Medium
    const fallback = this.modelMap.get("gemini-3.8-flash")!;
    return fallback.resolveTier(effort);
  }

  resolveNumericModelId(idOrKey: string, effort?: string): number {
    return this.resolveModel(idOrKey, effort).numericId;
  }
}
