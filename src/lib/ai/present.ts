import { computeSavings, totalTokens } from "./measure";

// How a finished run's usage is described to people. One formatter for the live result, the run history and the
// dashboard, so a number is always labelled the same way: provider-reported, estimated or unavailable.

export const PROVIDER_LABELS: Record<string, string> = { gemini: "Gemini", groq: "Groq", openrouter: "OpenRouter" };
export const providerLabel = (id: string | null | undefined) => (id ? (PROVIDER_LABELS[id] ?? id) : null);

export type RunMetrics = {
  provider: string | null;
  model: string | null;
  usageReported: boolean;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cachedInputTokens: number;
  costUsd: number;
  costKnown: boolean;
  // Provider calls of the run, retries and fallbacks included. Their tokens are only known for calls that succeeded.
  attempts: number;
  fallback: boolean;
  baselineTokensEstimate: number | null;
  contextTokensEstimate: number;
  techniques: string[];
  // The routing trail: every call, in order.
  attemptLog: { provider: string; model: string; outcome: string; usageReported: boolean }[];
};

const n = (value: number) => value.toLocaleString("en-US");

export type UsageDescription = {
  // "Groq · openai/gpt-oss-20b"
  model: string | null;
  tokens: string;
  savings: string;
  cost: string;
  // Plain statements about fallback and failed attempts; empty for a clean single-call run.
  routing: string[];
  techniques: string | null;
};

// "Groq (auth), Gemini (unavailable) x3": consecutive identical failures folded into a count.
function summarizeFailures(log: RunMetrics["attemptLog"]): string {
  const parts: { text: string; count: number }[] = [];
  for (const a of log.filter((entry) => entry.outcome !== "ok")) {
    const text = `${providerLabel(a.provider)} (${a.outcome.replace(/_/g, " ")})`;
    const last = parts.at(-1);
    if (last?.text === text) last.count++;
    else parts.push({ text, count: 1 });
  }
  return parts.map((p) => (p.count > 1 ? `${p.text} x${p.count}` : p.text)).join(", ");
}

export function describeUsage(m: RunMetrics, options: { costLabel?: string } = {}): UsageDescription {
  // No provider answered (the run failed or was stopped before a call succeeded): nothing was measured, so nothing is derived.
  if (m.provider === null) {
    const failures = summarizeFailures(m.attemptLog);
    return {
      model: null,
      tokens: "unavailable: no provider answered",
      savings: "Savings not measurable: no provider answered",
      cost: "Cost unavailable: no provider answered",
      routing: failures ? [`No provider answered: ${failures}.`] : [],
      techniques: m.techniques.length > 0 ? m.techniques.join(", ") : null,
    };
  }
  const total = totalTokens(m, m.usageReported);
  const tokens = m.usageReported
    ? `${n(m.inputTokens)} in / ${n(m.outputTokens)} out${m.thinkingTokens > 0 ? ` / ${n(m.thinkingTokens)} reasoning` : ""} (${n(total ?? 0)} total, reported by the provider)`
    : "not reported by the provider";

  const savings = computeSavings({ baselineTokens: m.baselineTokensEstimate, inputTokens: m.inputTokens, inputReported: m.usageReported, contextTokensEstimate: m.contextTokensEstimate });
  let savingsText: string;
  if (savings.tokensSaved === null || savings.baselineTokens === null) savingsText = "Savings not measurable for this run";
  else if (savings.tokensSaved <= 0) {
    savingsText = `No saving: used ${savings.optimizedSource === "estimated" ? "an estimated " : ""}${n(savings.optimizedTokens ?? 0)} input tokens against an estimated ${n(savings.baselineTokens)} for sending the whole snapshot`;
  }
  else {
    savingsText = `About ${n(savings.tokensSaved)} input tokens saved (${savings.reductionPercent}%) against an estimated ${n(savings.baselineTokens)} for sending the whole snapshot; estimated, not measured`;
  }

  const cost = m.costKnown ? `${options.costLabel ?? "est. cost"} $${m.costUsd.toFixed(4)}` : "Cost unavailable (no price known for this model)";

  const routing: string[] = [];
  const failed = m.attemptLog.filter((a) => a.outcome !== "ok");
  if (m.fallback) {
    const winner = [...m.attemptLog].reverse().find((a) => a.outcome === "ok");
    routing.push(`Fallback used: ${failed.length > 0 ? `${summarizeFailures(m.attemptLog)} did not answer; ` : ""}answered by ${providerLabel(winner?.provider ?? m.provider) ?? "another model"}.`);
  } else if (failed.length > 0) {
    routing.push(`${failed.length} provider call${failed.length === 1 ? "" : "s"} failed and ${failed.length === 1 ? "was" : "were"} retried; tokens of failed calls are not reported.`);
  }
  return { model: [providerLabel(m.provider), m.model].filter(Boolean).join(" · ") || null, tokens, savings: savingsText, cost, routing, techniques: m.techniques.length > 0 ? m.techniques.join(", ") : null };
}
