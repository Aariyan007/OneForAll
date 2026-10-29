// Token measurements: savings arithmetic and when it must refuse to produce one, the three kinds of numbers kept apart,
// aggregation that does not double-count or mix scopes, and how a run's usage is worded.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type UsageRow, computeSavings, estimateBaselineTokens, estimateTokensFromBytes, summarizeUsage, totalTokens } from "./measure";
import { type RunMetrics, describeUsage } from "./present";

describe("baseline estimate", () => {
  it("counts only files that have stored text, at four characters per token", () => {
    assert.equal(estimateBaselineTokens([{ hasText: true, sizeBytes: 4000 }, { hasText: false, sizeBytes: 999_999 }, { hasText: true, sizeBytes: 401 }]), 1101);
    assert.equal(estimateTokensFromBytes(0), 0);
    assert.equal(estimateBaselineTokens([]), 0);
  });
});

describe("savings", () => {
  const base = { baselineTokens: 10_000, inputTokens: 2_500, inputReported: true, contextTokensEstimate: 2_000 };

  it("is baseline minus the run's input, with the percentage of the baseline", () => {
    const s = computeSavings(base);
    assert.equal(s.tokensSaved, 7_500);
    assert.equal(s.reductionPercent, 75);
    assert.equal(s.optimizedTokens, 2_500);
    assert.equal(s.optimizedSource, "provider_reported");
  });

  it("rounds the percentage to one decimal", () => {
    assert.equal(computeSavings({ ...base, baselineTokens: 3, inputTokens: 1 }).reductionPercent, 66.7);
  });

  it("uses the estimated context size, and says so, when the provider reported no input count", () => {
    const s = computeSavings({ ...base, inputReported: false });
    assert.equal(s.optimizedTokens, 2_000);
    assert.equal(s.optimizedSource, "estimated");
    assert.equal(s.tokensSaved, 8_000);
  });

  it("makes no division by a zero or missing baseline", () => {
    for (const baselineTokens of [0, -5, null, undefined, Number.NaN]) {
      const s = computeSavings({ ...base, baselineTokens });
      assert.equal(s.tokensSaved, null);
      assert.equal(s.reductionPercent, null);
    }
  });

  it("claims nothing when the run's own input is unknown or zero", () => {
    const s = computeSavings({ ...base, inputTokens: 0, contextTokensEstimate: 0 });
    assert.equal(s.tokensSaved, null);
    assert.equal(s.baselineTokens, 10_000, "the baseline is still known");
  });

  it("reports a run that used more than the baseline as a negative saving, not as a clamped gain", () => {
    const s = computeSavings({ ...base, baselineTokens: 1_000, inputTokens: 1_800 });
    assert.equal(s.tokensSaved, -800);
    assert.equal(s.reductionPercent, -80);
  });

  it("totals tokens only when the provider reported them", () => {
    const usage = { inputTokens: 100, outputTokens: 20, thinkingTokens: 5 };
    assert.equal(totalTokens(usage, true), 125);
    assert.equal(totalTokens(usage, false), null);
  });
});

const row = (over: Partial<UsageRow> = {}): UsageRow => ({
  status: "completed", provider: "groq", usage_reported: true, input_tokens: 1000, output_tokens: 100, thinking_tokens: 0,
  baseline_tokens_estimate: 10_000, context_tokens_estimate: 800, fallback_used: false, attempts: 1, estimated_cost_usd: 0.001, cost_known: true, ...over,
});

describe("aggregation", () => {
  it("sums completed runs with provider-reported usage, and the savings of runs that have a baseline", () => {
    const s = summarizeUsage([row(), row({ input_tokens: 3000, output_tokens: 200 })]);
    assert.equal(s.completed, 2);
    assert.equal(s.inputTokens, 4000);
    assert.equal(s.outputTokens, 300);
    assert.equal(s.savedRuns, 2);
    assert.equal(s.baselineTokens, 20_000);
    assert.equal(s.tokensSaved, 16_000);
    assert.equal(s.reductionPercent, 80);
  });

  it("keeps failed and stopped runs out of the totals and reports their tokens separately", () => {
    const s = summarizeUsage([row(), row({ status: "failed", input_tokens: 500, output_tokens: 0 }), row({ status: "cancelled", usage_reported: false, input_tokens: 0 })]);
    assert.equal(s.completed, 1);
    assert.equal(s.failedOrStopped, 2);
    assert.equal(s.inputTokens, 1000);
    assert.equal(s.tokensInUnfinishedRuns, 500);
  });

  it("does not count a run's retries as extra runs or extra tokens", () => {
    const s = summarizeUsage([row({ attempts: 4, fallback_used: true })]);
    assert.equal(s.runs, 1);
    assert.equal(s.inputTokens, 1000, "tokens come from the successful call only");
    assert.equal(s.providerCalls, 4);
    assert.equal(s.fallbackRuns, 1);
  });

  it("leaves runs without reported usage out of the token totals and says how many", () => {
    const s = summarizeUsage([row(), row({ usage_reported: false, input_tokens: 0, output_tokens: 0 })]);
    assert.equal(s.reportedRuns, 1);
    assert.equal(s.unreportedRuns, 1);
    assert.equal(s.inputTokens, 1000);
  });

  it("makes no savings for runs without a baseline, such as runs recorded before tracking", () => {
    const s = summarizeUsage([row({ baseline_tokens_estimate: null })]);
    assert.equal(s.savedRuns, 0);
    assert.equal(s.tokensSaved, 0);
    assert.equal(s.reductionPercent, null);
  });

  it("does not add unknown costs as zero", () => {
    const s = summarizeUsage([row(), row({ cost_known: false, estimated_cost_usd: 0 })]);
    assert.equal(s.costUsd, 0.001);
    assert.equal(s.unknownCostRuns, 1);
  });

  it("counts runs per provider and handles no runs", () => {
    assert.deepEqual(summarizeUsage([row(), row({ provider: "gemini" }), row({ provider: null, status: "failed" })]).byProvider, { groq: 1, gemini: 1 });
    const empty = summarizeUsage([]);
    assert.equal(empty.runs, 0);
    assert.equal(empty.reductionPercent, null);
  });
});

const metrics = (over: Partial<RunMetrics> = {}): RunMetrics => ({
  provider: "groq", model: "openai/gpt-oss-20b", usageReported: true, inputTokens: 2500, outputTokens: 300, thinkingTokens: 0, cachedInputTokens: 0, costUsd: 0.0004, costKnown: true,
  attempts: 1, fallback: false, baselineTokensEstimate: 10_000, contextTokensEstimate: 2000, techniques: ["retrieval-based context selection"], attemptLog: [{ provider: "groq", model: "m", outcome: "ok", usageReported: true }], ...over,
});

describe("wording", () => {
  it("labels reported tokens, estimated savings and the cost", () => {
    const d = describeUsage(metrics());
    assert.equal(d.model, "Groq · openai/gpt-oss-20b");
    assert.match(d.tokens, /2,500 in \/ 300 out \(2,800 total, reported by the provider\)/);
    assert.match(d.savings, /7,500 input tokens saved \(75%\).*estimated, not measured/);
    assert.match(d.cost, /^est\. cost \$0\.0004$/);
    assert.deepEqual(d.routing, []);
  });

  it("says unavailable instead of showing zeros when the provider reported nothing", () => {
    const d = describeUsage(metrics({ usageReported: false, inputTokens: 0, outputTokens: 0, costKnown: false, costUsd: 0 }));
    assert.match(d.tokens, /not reported by the provider/);
    assert.ok(!/ 0 in/.test(d.tokens));
    assert.match(d.cost, /unavailable/);
  });

  it("says when nothing was saved or savings cannot be measured", () => {
    assert.match(describeUsage(metrics({ baselineTokensEstimate: 1000 })).savings, /^No saving/);
    assert.match(describeUsage(metrics({ baselineTokensEstimate: null })).savings, /not measurable/);
  });

  it("describes a fallback with the providers that failed, and a retried call without one", () => {
    const failed = { provider: "groq", model: "m", outcome: "rate_limited", usageReported: false };
    const won = { provider: "gemini", model: "g", outcome: "ok", usageReported: true };
    const d = describeUsage(metrics({ provider: "gemini", fallback: true, attempts: 2, attemptLog: [failed, won] }));
    assert.match(d.routing[0], /Fallback used: Groq \(rate limited\) did not answer; answered by Gemini\./);
    const repeated = describeUsage(metrics({ provider: "openrouter", fallback: true, attempts: 5, attemptLog: [failed, { ...failed, provider: "gemini", outcome: "unavailable" }, { ...failed, provider: "gemini", outcome: "unavailable" }, { ...won, provider: "openrouter" }] }));
    assert.match(repeated.routing[0], /Groq \(rate limited\), Gemini \(unavailable\) x2 did not answer; answered by OpenRouter/);
    const retried = describeUsage(metrics({ attempts: 2, attemptLog: [{ ...failed, provider: "groq", outcome: "unavailable" }, { provider: "groq", model: "m", outcome: "ok", usageReported: true }] }));
    assert.match(retried.routing[0], /1 provider call failed and was retried; tokens of failed calls are not reported/);
  });

  it("derives nothing for a run that no provider answered: no tokens, savings or cost, and the failures it met", () => {
    const failed = (provider: string, outcome: string) => ({ provider, model: "m", outcome, usageReported: false });
    const d = describeUsage(metrics({ provider: null, model: "openai/gpt-oss-20b", usageReported: false, inputTokens: 0, outputTokens: 0, costKnown: false, fallback: true, attempts: 5, attemptLog: [failed("groq", "auth"), failed("gemini", "unavailable"), failed("gemini", "unavailable"), failed("openrouter", "auth")] }));
    assert.equal(d.model, null);
    assert.match(d.tokens, /unavailable: no provider answered/);
    assert.match(d.savings, /not measurable: no provider answered/);
    assert.match(d.cost, /unavailable: no provider answered/);
    assert.deepEqual(d.routing, ["No provider answered: Groq (auth), Gemini (unavailable) x2, OpenRouter (auth)."]);
  });
});
