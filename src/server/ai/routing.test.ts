// Routing: which provider and model a task gets, and why. Pure: no network, no clock except the injected one.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelRegistry } from "./models";
import { Cooldowns, classifyTask, emptyPlanCategory, planRoute } from "./routing";
import type { JobType, Tier } from "./types";

const ALL = { GEMINI_API_KEY: "g".repeat(39), GROQ_API_KEY: "q".repeat(20), OPENROUTER_API_KEY: "o".repeat(20) };

function plan(job: JobType, tier: Tier, env: Record<string, string | undefined> = ALL, extra: { contextTokens?: number; cooldowns?: Cooldowns } = {}) {
  return planRoute({ job, tier, contextTokens: extra.contextTokens ?? 2000, reservedOutput: 4096, registry: modelRegistry(env), cooldowns: extra.cooldowns, needsTools: true });
}
const order = (p: ReturnType<typeof plan>) => p.candidates.map((c) => `${c.provider}:${c.model.id}`);

describe("classification", () => {
  it("maps every job to a category, splitting short questions from deeper ones", () => {
    assert.equal(classifyTask("code_qa", "fast"), "simple_qa");
    assert.equal(classifyTask("code_qa", "standard"), "repository_analysis");
    assert.equal(classifyTask("requirement_trace", "standard"), "repository_analysis");
    assert.equal(classifyTask("code_review", "standard"), "repository_analysis");
    assert.equal(classifyTask("bug_scan", "standard"), "bug_analysis");
    assert.equal(classifyTask("generate", "standard"), "code_generation");
    assert.equal(classifyTask("bug_fix_plan", "standard"), "fix_planning");
  });
});

describe("selection", () => {
  it("sends a simple question to the fast, cheap model first", () => {
    const p = plan("code_qa", "fast");
    assert.equal(p.category, "simple_qa");
    assert.equal(p.candidates[0].provider, "groq");
    assert.equal(p.candidates[0].model.id, "openai/gpt-oss-20b");
    assert.match(p.candidates[0].reason, /latency|price/);
  });

  it("sends analysis over a large context to the largest-context provider first, with a stronger model", () => {
    const p = plan("code_review", "standard");
    assert.equal(p.category, "repository_analysis");
    assert.equal(p.candidates[0].provider, "gemini");
    assert.equal(p.candidates[0].model.id, "gemini-3.8-flash");
  });

  it("does not always choose one provider: the order depends on the task", () => {
    const firsts = new Set((["code_qa", "code_review", "bug_scan", "generate", "bug_fix_plan"] as JobType[]).map((job) => plan(job, job === "code_qa" ? "fast" : "standard").candidates[0].provider));
    assert.ok(firsts.size > 1, `first provider per task: ${[...firsts].join(", ")}`);
  });

  it("keeps Gemini eligible, with its own cheaper tier behind the standard one, and lists the others after it", () => {
    const p = plan("code_review", "standard");
    assert.deepEqual(order(p), ["gemini:gemini-3.8-flash", "gemini:gemini-3.5-flash-lite", "groq:openai/gpt-oss-120b", "openrouter:openai/gpt-oss-120b"]);
  });

  it("is deterministic for the same inputs and configuration", () => {
    assert.deepEqual(order(plan("bug_scan", "standard")), order(plan("bug_scan", "standard")));
    assert.deepEqual(plan("generate", "standard"), plan("generate", "standard"));
  });

  it("explains each choice: the first candidate by policy, later ones as the next eligible", () => {
    const p = plan("code_review", "standard");
    assert.match(p.candidates[0].reason, /context/);
    assert.match(p.candidates[1].reason, /next eligible after gemini/);
    assert.ok(p.reason.length > 0 && !/key|secret/i.test(p.reason));
  });
});

describe("availability", () => {
  it("skips a provider whose API key is missing, and says so", () => {
    const p = plan("code_qa", "fast", { ...ALL, GROQ_API_KEY: undefined });
    assert.deepEqual(p.candidates.map((c) => c.provider), ["gemini", "openrouter"]);
    assert.deepEqual(p.skipped, [{ provider: "groq", model: null, why: "not_configured" }]);
  });

  it("routes to the only configured provider, and to none when nothing is configured", () => {
    assert.deepEqual(plan("code_qa", "fast", { GROQ_API_KEY: "q".repeat(20) }).candidates.map((c) => c.provider), ["groq"]);
    const none = plan("code_qa", "fast", {});
    assert.equal(none.candidates.length, 0);
    assert.equal(emptyPlanCategory(none), "not_configured");
  });

  it("does not select a provider whose configured model id is not a valid id", () => {
    const registry = modelRegistry({ ...ALL, GROQ_MODEL_STANDARD: "bad model; drop" });
    assert.equal(registry.providers.groq.configured, false);
    assert.match(registry.providers.groq.problem ?? "", /not a valid model id/);
    const p = planRoute({ job: "code_qa", tier: "fast", contextTokens: 10, reservedOutput: 100, registry });
    assert.ok(!p.candidates.some((c) => c.provider === "groq"));
  });

  it("honours model id overrides from the environment", () => {
    const p = plan("code_qa", "fast", { ...ALL, GROQ_MODEL_FAST: "llama-3.1-8b-instant" });
    assert.equal(p.candidates[0].model.id, "llama-3.1-8b-instant");
    assert.equal(p.candidates[0].model.priceKnown, false, "an override has no known price unless it is tabulated");
  });
});

describe("context window", () => {
  it("drops models whose window cannot hold the context, and keeps the larger one", () => {
    const p = plan("code_qa", "fast", ALL, { contextTokens: 200_000 });
    assert.ok(!p.candidates.some((c) => c.provider === "groq" || c.provider === "openrouter"), "131k windows are too small");
    assert.deepEqual(p.candidates.map((c) => c.provider), ["gemini"]);
    assert.ok(p.skipped.filter((s) => s.why === "context").length >= 2);
  });

  it("reports a context overflow when nothing fits", () => {
    const p = plan("code_qa", "fast", { GROQ_API_KEY: "q".repeat(20) }, { contextTokens: 200_000 });
    assert.equal(p.candidates.length, 0);
    assert.equal(emptyPlanCategory(p), "context_overflow");
  });

  it("counts the prompt overhead and the reserved output, not just the context", () => {
    const fits = planRoute({ job: "code_qa", tier: "fast", contextTokens: 120_000, reservedOutput: 4096, registry: modelRegistry({ GROQ_API_KEY: "q".repeat(20) }) });
    assert.equal(fits.candidates.length, 1);
    const tight = planRoute({ job: "code_qa", tier: "fast", contextTokens: 125_000, reservedOutput: 4096, registry: modelRegistry({ GROQ_API_KEY: "q".repeat(20) }) });
    assert.equal(tight.candidates.length, 0);
  });
});

describe("cooldowns", () => {
  it("steers away from a provider whose key was rejected, until the cooldown ends", () => {
    let now = 0;
    const cooldowns = new Cooldowns(() => now);
    cooldowns.note("groq", "openai/gpt-oss-20b", "auth");
    assert.deepEqual(plan("code_qa", "fast", ALL, { cooldowns }).candidates.map((c) => c.provider), ["gemini", "openrouter"]);
    now += 11 * 60_000;
    assert.equal(plan("code_qa", "fast", ALL, { cooldowns }).candidates[0].provider, "groq");
  });

  it("does not select a model the provider said it does not support", () => {
    const cooldowns = new Cooldowns(() => 0);
    cooldowns.note("openrouter", "openai/gpt-oss-120b", "unsupported_model");
    const p = plan("generate", "standard", ALL, { cooldowns });
    assert.ok(!p.candidates.some((c) => c.provider === "openrouter"));
    assert.ok(p.candidates.some((c) => c.provider === "groq"), "the same model id on another provider is unaffected");
  });

  it("cools a rate-limited model for the provider's Retry-After, within bounds", () => {
    let now = 0;
    const cooldowns = new Cooldowns(() => now);
    cooldowns.note("groq", "m", "rate_limited", 120);
    assert.ok(cooldowns.blocked("model:groq:m"));
    now = 119_000;
    assert.ok(cooldowns.blocked("model:groq:m"));
    now = 121_000;
    assert.equal(cooldowns.blocked("model:groq:m"), null);
    cooldowns.note("groq", "m", "rate_limited", 99_999);
    assert.equal(cooldowns.blocked("model:groq:m")!.until - now, 5 * 60_000, "capped at five minutes");
  });

  it("does not remember failures that are about the task, not the provider", () => {
    const cooldowns = new Cooldowns(() => 0);
    for (const category of ["context_overflow", "invalid_request", "bad_output", "network", "timeout", "unavailable"] as const) cooldowns.note("groq", "m", category);
    assert.equal(cooldowns.blocked("provider:groq"), null);
    assert.equal(cooldowns.blocked("model:groq:m"), null);
  });

  it("never leaves a plan empty because of cooldowns: the only provider is tried again", () => {
    const cooldowns = new Cooldowns(() => 0);
    cooldowns.note("gemini", "gemini-3.5-flash-lite", "rate_limited", 30);
    const p = plan("code_qa", "fast", { GEMINI_API_KEY: "g".repeat(39) }, { cooldowns });
    assert.deepEqual(order(p), ["gemini:gemini-3.5-flash-lite"]);
  });
});
