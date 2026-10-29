import { SAFETY_MARGIN_TOKENS } from "./budget";
import type { ModelRegistry, ModelSpec } from "./models";
import type { JobType, ProviderErrorCategory, ProviderId, Tier } from "./types";

// The one place that decides WHICH provider and model answers a task. Pure and deterministic for the same inputs,
// configuration and cooldown state, so it is tested without a network. The orchestrator asks for a plan once per run and
// walks it on failure (orchestrator.ts); nothing else chooses a provider.
//
// It never decides who may ask (authorization runs before) and never sees prompts or keys.

export type TaskCategory = "simple_qa" | "repository_analysis" | "bug_analysis" | "code_generation" | "fix_planning";

// What a job is, for routing. A short question over a small context (the existing "fast" tier decision) is simple;
// every other use of the same job reasons over more code.
export function classifyTask(job: JobType, tier: Tier): TaskCategory {
  switch (job) {
    case "code_qa":
      return tier === "fast" ? "simple_qa" : "repository_analysis";
    case "requirement_trace":
    case "code_review":
      return "repository_analysis";
    case "bug_scan":
      return "bug_analysis";
    case "generate":
      return "code_generation";
    case "bug_fix_plan":
      return "fix_planning";
  }
}

// Provider order per category, best first, with the reason. Correctness and context come before price:
//  - simple questions go to the fastest, cheapest model that answers them well (Groq's small model);
//  - analysis over many files goes first to the provider with the largest context window (Gemini, 1M tokens vs 131k);
//  - generated code and fix plans go first to the provider whose behavior the output validation was tuned on.
// Availability, context size and cooldowns then remove providers from the order; nothing is hard-wired to one provider.
const POLICY: Record<TaskCategory, { order: readonly ProviderId[]; reason: string }> = {
  simple_qa: { order: ["groq", "gemini", "openrouter"], reason: "short question over a small context: lowest latency and price" },
  repository_analysis: { order: ["gemini", "groq", "openrouter"], reason: "code understanding needs the largest context window" },
  bug_analysis: { order: ["gemini", "groq", "openrouter"], reason: "structured findings over many files need a large context and reliable JSON" },
  code_generation: { order: ["gemini", "openrouter", "groq"], reason: "code output needs the most reliable structured generation" },
  fix_planning: { order: ["gemini", "groq", "openrouter"], reason: "fix plans need strong code reasoning and reliable JSON" },
};

export type Candidate = { provider: ProviderId; tier: Tier; model: ModelSpec; reason: string };
export type Skipped = { provider: ProviderId; model: string | null; why: "not_configured" | "no_capability" | "context" | "cooldown"; category?: ProviderErrorCategory };
export type RoutePlan = { category: TaskCategory; reason: string; candidates: Candidate[]; skipped: Skipped[] };

// Rough size of the system prompt and framing around a job's context; the real count comes from the provider afterwards.
const PROMPT_OVERHEAD_TOKENS = 3000;

export type RouteInput = {
  job: JobType;
  tier: Tier;
  contextTokens: number;
  reservedOutput: number;
  registry: ModelRegistry;
  cooldowns?: Cooldowns;
  // Jobs that use tools need function calling.
  needsTools?: boolean;
};

export function planRoute(input: RouteInput): RoutePlan {
  const plan = buildPlan(input, input.cooldowns);
  // Cooldowns only steer AWAY from a provider while another one can answer. When they would leave nothing (a single
  // configured provider that was rate limited a minute ago), trying again is better than failing without a call.
  if (plan.candidates.length === 0 && plan.skipped.some((s) => s.why === "cooldown")) return buildPlan(input, undefined);
  return plan;
}

function buildPlan(input: RouteInput, cooldowns: Cooldowns | undefined): RoutePlan {
  const category = classifyTask(input.job, input.tier);
  const policy = POLICY[category];
  const needed = input.contextTokens + PROMPT_OVERHEAD_TOKENS + input.reservedOutput + SAFETY_MARGIN_TOKENS;
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];

  for (const id of policy.order) {
    const provider = input.registry.providers[id];
    if (!provider.configured) {
      skipped.push({ provider: id, model: null, why: "not_configured" });
      continue;
    }
    // Gemini keeps its own tier chain (standard, then the cheaper fast model); the others answer with the chosen tier only.
    const tiers: Tier[] = id === "gemini" ? input.registry.fallbackChain(input.tier) : [input.tier];
    const providerBlock = cooldowns?.blocked(`provider:${id}`);
    for (const tier of tiers) {
      const model = tier === "deep" ? (input.registry.models.deep ?? provider.models.standard) : provider.models[tier === "fast" ? "fast" : "standard"];
      if (providerBlock) skipped.push({ provider: id, model: model.id, why: "cooldown", category: providerBlock.category });
      else if (cooldowns?.blocked(`model:${id}:${model.id}`)) skipped.push({ provider: id, model: model.id, why: "cooldown", category: cooldowns.blocked(`model:${id}:${model.id}`)!.category });
      else if (!model.supportsJson || (input.needsTools && !model.supportsTools)) skipped.push({ provider: id, model: model.id, why: "no_capability" });
      else if (needed > model.contextLimit) skipped.push({ provider: id, model: model.id, why: "context" });
      else candidates.push({ provider: id, tier, model, reason: candidates.length === 0 ? policy.reason : `next eligible after ${candidates[candidates.length - 1].provider}` });
    }
  }
  return { category, reason: policy.reason, candidates, skipped };
}

// Why a plan has no candidate, as the error category the run reports.
export function emptyPlanCategory(plan: RoutePlan): ProviderErrorCategory | "not_configured" {
  const cooled = plan.skipped.find((s) => s.why === "cooldown" && s.category);
  if (cooled?.category) return cooled.category;
  if (plan.skipped.some((s) => s.why === "context")) return "context_overflow";
  return plan.skipped.every((s) => s.why === "not_configured") ? "not_configured" : "unavailable";
}

// ---------------------------------------------------------------- cooldowns

// Remembers, per process, what just failed so the next run does not start with a provider that is known to be down:
// a rejected key (the whole provider), an unsupported model, a spent quota or a rate limit (that model). In memory and
// best effort by design: another instance learns the same way, from its own first failure. Not a health-check service.

const COOLDOWN_MS = { auth: 10 * 60_000, unsupported_model: 60 * 60_000, quota: 15 * 60_000, rate_limited: 60_000, maxRateLimited: 5 * 60_000 } as const;

export type Cooldown = { until: number; category: ProviderErrorCategory };

export class Cooldowns {
  private readonly entries = new Map<string, Cooldown>();
  constructor(private readonly now: () => number = Date.now) {}

  blocked(key: string): Cooldown | null {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.until <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  // Records a failure of `model` on `provider`. Only failures that say something about the provider or model are kept;
  // a malformed request or a context overflow is about the task, not the provider.
  note(provider: ProviderId, model: string, category: ProviderErrorCategory, retryAfterSeconds?: number): void {
    const at = this.now();
    if (category === "auth") this.entries.set(`provider:${provider}`, { until: at + COOLDOWN_MS.auth, category });
    else if (category === "unsupported_model") this.entries.set(`model:${provider}:${model}`, { until: at + COOLDOWN_MS.unsupported_model, category });
    else if (category === "quota") this.entries.set(`model:${provider}:${model}`, { until: at + COOLDOWN_MS.quota, category });
    else if (category === "rate_limited") {
      const ms = Math.min(COOLDOWN_MS.maxRateLimited, Math.max(COOLDOWN_MS.rate_limited, (retryAfterSeconds ?? 0) * 1000));
      this.entries.set(`model:${provider}:${model}`, { until: at + ms, category });
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

export const PROCESS_COOLDOWNS = new Cooldowns();
