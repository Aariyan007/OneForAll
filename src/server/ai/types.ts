// Shared vocabulary of the AI layer. Pure types and constants: no I/O, safe to import from tests.

export const JOB_TYPES = ["code_qa", "requirement_trace", "code_review", "generate", "bug_scan", "bug_fix_plan"] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const RUN_STATES = [
  "queued",
  "validating",
  "retrieving_context",
  "generating",
  "executing_tool",
  "validating_output",
  "completed",
  "failed",
  "cancelled",
  "timed_out",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export type Tier = "fast" | "standard" | "deep";

// The model providers the router can use. Gemini is the original; Groq and OpenRouter are OpenAI-compatible APIs.
export const PROVIDER_IDS = ["gemini", "groq", "openrouter"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// Provider failures, normalized. Only rate_limited, unavailable and network are retried (retry.ts). "unsupported_model" means
// the provider does not know the configured model id: permanent for that model, so it is skipped, never retried.
export type ProviderErrorCategory =
  | "auth"
  | "quota"
  | "rate_limited"
  | "context_overflow"
  | "invalid_request"
  | "unavailable"
  | "network"
  | "timeout"
  | "unsupported_model"
  | "safety_blocked"
  | "bad_output";

// Why a run ended without a result. Safe to show and store: never contains prompts, code or keys.
export type RunErrorCategory =
  | ProviderErrorCategory
  | "not_configured"
  | "disabled"
  | "invalid_input"
  | "no_source"
  | "limit_exceeded"
  | "tool_error"
  | "cancelled"
  | "deadline"
  | "internal";

// One provider call of a run, for the routing trail. Safe to store and show: no prompts, keys or provider messages.
export type AttemptRecord = {
  provider: ProviderId;
  model: string;
  tier: Tier;
  // "ok", or the normalized failure category of this call.
  outcome: "ok" | ProviderErrorCategory;
  ms: number;
  // Whether the provider reported token usage for this call (always false for a failed call).
  usageReported: boolean;
};

export type Usage = { inputTokens: number; outputTokens: number; cachedInputTokens: number; thinkingTokens: number };

export const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, thinkingTokens: 0 };

export function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    thinkingTokens: a.thinkingTokens + b.thinkingTokens,
  };
}

// 1-based, inclusive line range in a snapshot file.
export type Citation = { path: string; startLine: number; endLine: number };
