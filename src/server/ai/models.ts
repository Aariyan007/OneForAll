import { PROVIDER_IDS, type ProviderId, type Tier, type Usage } from "./types";

// Configuration-driven model registry. Model ids come from the environment with documented defaults; limits and
// prices are configuration, not facts the code relies on. A price is only used when it is known: an unknown price gives
// "cost unavailable", never zero.
//
// Gemini prices are USD per 1M tokens from the Gemini API pricing page (paid tier) as read on 2026-10-26; the free tier
// costs nothing, so the app labels them "estimated paid-tier cost". Groq prices are from Groq's models page as read on
// 2026-10-29. OpenRouter reports the real cost of each call itself (usage.cost), so it needs no table. Update
// PRICES_AS_OF and the tables when the pages change.

export const PRICES_AS_OF = "2026-10-29";

export type ModelSpec = {
  provider: ProviderId;
  tier: Tier;
  id: string;
  contextLimit: number; // configured, not discovered; job budgets stay far below it
  maxOutputTokens: number;
  // The job prompts rely on function calling and JSON answers; a configured model must offer both.
  supportsTools: boolean;
  supportsJson: boolean;
  // False when the price of this model is not known: cost is then "unavailable" instead of 0.
  priceKnown: boolean;
  priceInputPerM: number;
  priceOutputPerM: number;
  priceCachedInputPerM: number;
};

type Price = { input: number; output: number; cached: number };

const GEMINI_PRICES: Record<string, Price> = {
  "gemini-3.8-flash": { input: 0.75, output: 3.75, cached: 0.075 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
  "gemini-4-argon": { input: 2, output: 10, cached: 0.1 },
};

// Groq lists no cached-input discount for these models, so cached tokens are priced like the rest of the input.
const GROQ_PRICES: Record<string, Price> = {
  "openai/gpt-oss-20b": { input: 0.075, output: 0.3, cached: 0.075 },
  "openai/gpt-oss-120b": { input: 0.15, output: 0.6, cached: 0.15 },
};

const DEFAULT_MODELS: Record<ProviderId, { fast: string; standard: string }> = {
  gemini: { fast: "gemini-3.5-flash-lite", standard: "gemini-3.8-flash" },
  groq: { fast: "openai/gpt-oss-20b", standard: "openai/gpt-oss-120b" },
  openrouter: { fast: "openai/gpt-oss-20b", standard: "openai/gpt-oss-120b" },
};

const CONTEXT_LIMIT: Record<ProviderId, number> = { gemini: 1_000_000, groq: 131_072, openrouter: 131_072 };
const PRICES: Record<ProviderId, Record<string, Price>> = { gemini: GEMINI_PRICES, groq: GROQ_PRICES, openrouter: {} };

// A model id is passed to a provider API as-is, so it is restricted to what real ids look like.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;

function spec(provider: ProviderId, tier: Tier, id: string): ModelSpec {
  const price = PRICES[provider][id];
  return {
    provider,
    tier,
    id,
    contextLimit: CONTEXT_LIMIT[provider],
    maxOutputTokens: 8192,
    supportsTools: true,
    supportsJson: true,
    priceKnown: price !== undefined,
    priceInputPerM: price?.input ?? 0,
    priceOutputPerM: price?.output ?? 0,
    priceCachedInputPerM: price?.cached ?? 0,
  };
}

export type ProviderConfig = {
  id: ProviderId;
  // True when the key is present and the configured model ids are valid.
  configured: boolean;
  apiKey: string | null;
  // Why a provider with a key is still unusable (an invalid model id); null otherwise. Safe to show: no secrets.
  problem: string | null;
  models: { fast: ModelSpec; standard: ModelSpec };
};

export type ModelRegistry = {
  // Whether ANY provider is usable. Routing skips the unconfigured ones.
  configured: boolean;
  // The Gemini key and tier models, unchanged: the evaluation script and the Gemini fallback chain use them directly.
  apiKey: string | null;
  models: { fast: ModelSpec; standard: ModelSpec; deep?: ModelSpec };
  providers: Record<ProviderId, ProviderConfig>;
  fallbackChain(tier: Tier): Tier[];
  estimateCostUsd(tier: Tier, usage: Usage): number;
  // Cost of one call on a model in USD, or null when its price is not known.
  costFor(model: ModelSpec, usage: Usage): number | null;
};

type Env = Readonly<Record<string, string | undefined>>;

const ENV_NAMES: Record<ProviderId, { key: string; fast: string; standard: string }> = {
  gemini: { key: "GEMINI_API_KEY", fast: "AI_MODEL_FAST", standard: "AI_MODEL_STANDARD" },
  groq: { key: "GROQ_API_KEY", fast: "GROQ_MODEL_FAST", standard: "GROQ_MODEL_STANDARD" },
  openrouter: { key: "OPENROUTER_API_KEY", fast: "OPENROUTER_MODEL_FAST", standard: "OPENROUTER_MODEL_STANDARD" },
};

function providerConfig(id: ProviderId, env: Env): ProviderConfig {
  const names = ENV_NAMES[id];
  const apiKey = env[names.key]?.trim() || null;
  const fastId = env[names.fast]?.trim() || DEFAULT_MODELS[id].fast;
  const standardId = env[names.standard]?.trim() || DEFAULT_MODELS[id].standard;
  const valid = MODEL_ID.test(fastId) && MODEL_ID.test(standardId);
  return {
    id,
    configured: apiKey !== null && valid,
    apiKey,
    problem: apiKey !== null && !valid ? `${names.fast} or ${names.standard} is not a valid model id.` : null,
    models: { fast: spec(id, "fast", fastId), standard: spec(id, "standard", standardId) },
  };
}

export function modelRegistry(env: Env): ModelRegistry {
  const providers = Object.fromEntries(PROVIDER_IDS.map((id) => [id, providerConfig(id, env)])) as Record<ProviderId, ProviderConfig>;
  const gemini = providers.gemini;
  const deepId = env.AI_MODEL_DEEP?.trim();
  const models = { fast: gemini.models.fast, standard: gemini.models.standard, deep: deepId ? spec("gemini", "deep", deepId) : undefined };
  const pick = (tier: Tier): ModelSpec => (tier === "deep" ? (models.deep ?? models.standard) : models[tier]);
  const costFor = (model: ModelSpec, usage: Usage): number | null => {
    if (!model.priceKnown) return null;
    const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens);
    const cost =
      (uncachedInput * model.priceInputPerM + usage.cachedInputTokens * model.priceCachedInputPerM + (usage.outputTokens + usage.thinkingTokens) * model.priceOutputPerM) / 1_000_000;
    return Math.round(cost * 1e6) / 1e6;
  };
  return {
    configured: PROVIDER_IDS.some((id) => providers[id].configured),
    apiKey: gemini.apiKey,
    models,
    providers,
    // Within Gemini, fallback only goes DOWN to a cheaper tier, never up to the paid deep tier, and the run records that it happened.
    fallbackChain(tier) {
      if (tier === "deep") return models.deep ? ["deep", "standard", "fast"] : ["standard", "fast"];
      return tier === "standard" ? ["standard", "fast"] : ["fast"];
    },
    estimateCostUsd(tier, usage) {
      return costFor(pick(tier), usage) ?? 0;
    },
    costFor,
  };
}
