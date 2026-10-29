// Token measurements of AI runs. Pure (no I/O): the orchestrator fills it in, the pages render it and the tests pin the rules.
//
// Three kinds of numbers are kept apart and never mixed silently:
//   provider-reported  tokens the provider counted for a call (input, output). Unavailable when a provider sent none.
//   estimated          an internal estimate (characters / 4, not a tokenizer).
//   unavailable        nothing trustworthy exists; shown as such, never as 0.
//
// Savings compare ONE thing against ONE thing: the estimated size of sending the whole stored snapshot in a single request
// (the baseline) against the input tokens the run actually used. The baseline is an estimate, so a saving is always labelled
// "estimated", even when the run's own input count is provider-reported. The baseline counts repository text only, not the
// prompt around it, so it understates what a whole-snapshot request would cost and the saving is conservative.

const CHARS_PER_TOKEN = 4;

export function estimateTokensFromBytes(bytes: number): number {
  return bytes > 0 ? Math.ceil(bytes / CHARS_PER_TOKEN) : 0;
}

// Estimated tokens of every stored text file of the snapshot, i.e. what "send the whole repository" would need.
export function estimateBaselineTokens(files: readonly { hasText: boolean; sizeBytes: number }[]): number {
  return estimateTokensFromBytes(files.reduce((sum, f) => sum + (f.hasText ? f.sizeBytes : 0), 0));
}

export type TokenSavings = {
  baselineTokens: number | null;
  optimizedTokens: number | null;
  // Negative when the run used MORE than the baseline (small snapshots): reported as it is, not clamped to a saving.
  tokensSaved: number | null;
  reductionPercent: number | null;
  // Where the optimized number came from. The saving itself is always an estimate (see the header).
  optimizedSource: "provider_reported" | "estimated" | null;
};

export const NO_SAVINGS: TokenSavings = { baselineTokens: null, optimizedTokens: null, tokensSaved: null, reductionPercent: null, optimizedSource: null };

export function computeSavings(input: {
  baselineTokens: number | null | undefined;
  // Input tokens summed over the run's successful calls, and whether the provider reported them.
  inputTokens: number;
  inputReported: boolean;
  // Estimated size of the context the run assembled; only used when no provider count exists.
  contextTokensEstimate: number;
}): TokenSavings {
  const baseline = input.baselineTokens;
  if (baseline === null || baseline === undefined || !Number.isFinite(baseline) || baseline <= 0) return NO_SAVINGS;
  const optimized = input.inputReported ? input.inputTokens : input.contextTokensEstimate;
  if (!Number.isFinite(optimized) || optimized <= 0) return { ...NO_SAVINGS, baselineTokens: baseline };
  const saved = baseline - optimized;
  return {
    baselineTokens: baseline,
    optimizedTokens: optimized,
    tokensSaved: saved,
    reductionPercent: Math.round((saved / baseline) * 1000) / 10,
    optimizedSource: input.inputReported ? "provider_reported" : "estimated",
  };
}

// Total tokens only when the provider reported them: input + output + reasoning. Otherwise unavailable.
export function totalTokens(usage: { inputTokens: number; outputTokens: number; thinkingTokens: number }, reported: boolean): number | null {
  return reported ? usage.inputTokens + usage.outputTokens + usage.thinkingTokens : null;
}

// ---------------------------------------------------------------- aggregation for the dashboard

export type UsageRow = {
  status: string;
  provider: string | null;
  usage_reported: boolean;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  baseline_tokens_estimate: number | null;
  context_tokens_estimate: number;
  fallback_used: boolean;
  attempts: number;
  estimated_cost_usd: number;
  cost_known: boolean;
};

export type UsageSummary = {
  runs: number;
  completed: number;
  failedOrStopped: number;
  // Token totals cover COMPLETED runs whose provider reported usage; `unreportedRuns` says how many completed runs are left out.
  reportedRuns: number;
  unreportedRuns: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  // Tokens of calls that succeeded inside runs that did not complete. Kept apart from the totals above.
  tokensInUnfinishedRuns: number;
  fallbackRuns: number;
  // Calls to a provider across all runs, including retries and fallbacks (not tokens: failed calls report none).
  providerCalls: number;
  byProvider: Record<string, number>;
  // Estimated savings, summed only over completed runs that have a baseline and a usable input count.
  savedRuns: number;
  baselineTokens: number;
  tokensSaved: number;
  reductionPercent: number | null;
  // Cost over completed runs whose cost is known; `unknownCostRuns` are left out, not counted as free.
  costUsd: number;
  unknownCostRuns: number;
};

export function summarizeUsage(rows: readonly UsageRow[]): UsageSummary {
  const out: UsageSummary = {
    runs: rows.length,
    completed: 0,
    failedOrStopped: 0,
    reportedRuns: 0,
    unreportedRuns: 0,
    inputTokens: 0,
    outputTokens: 0,
    thinkingTokens: 0,
    tokensInUnfinishedRuns: 0,
    fallbackRuns: 0,
    providerCalls: 0,
    byProvider: {},
    savedRuns: 0,
    baselineTokens: 0,
    tokensSaved: 0,
    reductionPercent: null,
    costUsd: 0,
    unknownCostRuns: 0,
  };
  for (const row of rows) {
    out.providerCalls += row.attempts;
    if (row.provider) out.byProvider[row.provider] = (out.byProvider[row.provider] ?? 0) + 1;
    if (row.fallback_used) out.fallbackRuns++;
    if (row.status !== "completed") {
      out.failedOrStopped++;
      if (row.usage_reported) out.tokensInUnfinishedRuns += row.input_tokens + row.output_tokens + row.thinking_tokens;
      continue;
    }
    out.completed++;
    if (!row.usage_reported) out.unreportedRuns++;
    else {
      out.reportedRuns++;
      out.inputTokens += row.input_tokens;
      out.outputTokens += row.output_tokens;
      out.thinkingTokens += row.thinking_tokens;
    }
    const savings = computeSavings({
      baselineTokens: row.baseline_tokens_estimate,
      inputTokens: row.input_tokens,
      inputReported: row.usage_reported,
      contextTokensEstimate: row.context_tokens_estimate,
    });
    if (savings.tokensSaved !== null && savings.baselineTokens !== null) {
      out.savedRuns++;
      out.baselineTokens += savings.baselineTokens;
      out.tokensSaved += savings.tokensSaved;
    }
    if (row.cost_known) out.costUsd += row.estimated_cost_usd;
    else out.unknownCostRuns++;
  }
  out.costUsd = Math.round(out.costUsd * 1e6) / 1e6;
  out.reductionPercent = out.baselineTokens > 0 ? Math.round((out.tokensSaved / out.baselineTokens) * 1000) / 10 : null;
  return out;
}
