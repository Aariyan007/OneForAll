// Shared vocabulary of the AI layer. Pure types and constants: no I/O, safe to import from tests.

export const JOB_TYPES = ["code_qa", "requirement_trace", "code_review", "generate", "bug_scan"] as const;
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

// Provider failures, normalized. Only rate_limited, unavailable and network are retried (retry.ts).
export type ProviderErrorCategory =
  | "auth"
  | "quota"
  | "rate_limited"
  | "context_overflow"
  | "invalid_request"
  | "unavailable"
  | "network"
  | "timeout"
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
