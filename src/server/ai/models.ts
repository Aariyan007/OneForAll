import type { Tier, Usage } from "./types";

// Configuration-driven model registry. Model ids come from the environment with documented defaults; limits and
// prices are configuration, not facts the code relies on. Prices are USD per 1M tokens from the Gemini API pricing
// page (paid tier) as read on 2026-10-26; the free tier costs nothing, so the app labels these as "estimated paid-tier
// cost". Update PRICES_AS_OF and the table when the page changes.

export const PRICES_AS_OF = "2026-10-26";

export type ModelSpec = {
  tier: Tier;
  id: string;
  contextLimit: number; // configured, not discovered; job budgets stay far below it
  maxOutputTokens: number;
  priceInputPerM: number;
  priceOutputPerM: number;
  priceCachedInputPerM: number;
};

const KNOWN_PRICES: Record<string, { input: number; output: number; cached: number }> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
  "gemini-4-argon": { input: 2, output: 10, cached: 0.1 },
};

const DEFAULTS: Record<"fast" | "standard", string> = {
  fast: "gemini-3.5-flash-lite",
  standard: "gemini-3.8-flash",
};

function spec(tier: Tier, id: string): ModelSpec {
  const price = KNOWN_PRICES[id] ?? { input: 0, output: 0, cached: 0 };
  return {
    tier,
    id,
    contextLimit: 1_000_000,
    maxOutputTokens: 8192,
    priceInputPerM: price.input,
    priceOutputPerM: price.output,
    priceCachedInputPerM: price.cached,
  };
}

export type ModelRegistry = {
  configured: boolean;
  apiKey: string | null;
  models: { fast: ModelSpec; standard: ModelSpec; deep?: ModelSpec };
  fallbackChain(tier: Tier): Tier[];
  estimateCostUsd(tier: Tier, usage: Usage): number;
};

type Env = Readonly<Record<string, string | undefined>>;

export function modelRegistry(env: Env): ModelRegistry {
  const apiKey = env.GEMINI_API_KEY?.trim() || null;
  const deepId = env.AI_MODEL_DEEP?.trim();
  const models = {
    fast: spec("fast", env.AI_MODEL_FAST?.trim() || DEFAULTS.fast),
    standard: spec("standard", env.AI_MODEL_STANDARD?.trim() || DEFAULTS.standard),
    deep: deepId ? spec("deep", deepId) : undefined,
  };
  const pick = (tier: Tier): ModelSpec => (tier === "deep" ? (models.deep ?? models.standard) : models[tier]);
  return {
    configured: apiKey !== null,
    apiKey,
    models,
    // Fallback only goes DOWN to a cheaper tier, never up to the paid deep tier, and the run records that it happened.
    fallbackChain(tier) {
      if (tier === "deep") return models.deep ? ["deep", "standard", "fast"] : ["standard", "fast"];
      return tier === "standard" ? ["standard", "fast"] : ["fast"];
    },
    estimateCostUsd(tier, usage) {
      const model = pick(tier);
      const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
      const cost =
        (uncachedInput * model.priceInputPerM +
          usage.cachedInputTokens * model.priceCachedInputPerM +
          (usage.outputTokens + usage.thinkingTokens) * model.priceOutputPerM) /
        1_000_000;
      return Math.round(cost * 1e6) / 1e6;
    },
  };
}
