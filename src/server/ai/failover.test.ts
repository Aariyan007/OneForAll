// Multi-provider failover through the orchestrator, with scripted providers and, at the end, the real Groq/OpenRouter
// adapters over mocked HTTP: which provider is tried, what is retried, what is skipped, what is recorded, and that a failed
// attempt never becomes a fake answer. No network, no database, no keys.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelRegistry } from "./models";
import { type OrchestratorDeps, runJob } from "./orchestrator";
import { FakeProvider, type FakeStep } from "./provider/fake";
import { createOpenAiCompatibleProvider } from "./provider/openai-compatible";
import { LlmError, type LlmProvider } from "./provider/types";
import { Cooldowns } from "./routing";
import { memoryReader } from "./test-support";
import type { ProviderId, RunState } from "./types";

const STORE = ["export class TaskStore {", "  findOverdue(now: Date) {", "    return [];", "  }", "}"].join("\n");
const ALL = { GEMINI_API_KEY: "g".repeat(39), GROQ_API_KEY: "q".repeat(20), OPENROUTER_API_KEY: "o".repeat(20) };
const QUESTION = { question: "Where is findOverdue defined?" };

const answer = () => JSON.stringify({ answer: "findOverdue is on line 2.", citations: [{ path: "src/tasks/store.ts", startLine: 2, endLine: 4 }], confidence: "high", missingContext: [] });
const review = () => JSON.stringify({ summary: "ok", findings: [], confidence: "low", missingContext: [] });
const USAGE = { inputTokens: 900, outputTokens: 60, cachedInputTokens: 0, thinkingTokens: 0 };
const down = () => new LlmError("unavailable", "503");

type Fakes = Partial<Record<ProviderId, FakeProvider>>;

function harness(env: Record<string, string | undefined>, scripts: Partial<Record<ProviderId, FakeStep[]>>, overrides: Partial<OrchestratorDeps> = {}) {
  const states: RunState[] = [];
  const sleeps: number[] = [];
  const fakes: Fakes = {};
  for (const id of Object.keys(scripts) as ProviderId[]) fakes[id] = new FakeProvider(scripts[id]!);
  let clock = 0;
  const deps: OrchestratorDeps = {
    providers: fakes as Record<string, LlmProvider>,
    registry: modelRegistry(env),
    reader: memoryReader({ "src/tasks/store.ts": STORE }),
    store: { transition: async (state) => void states.push(state), cancelRequested: async () => false },
    now: () => (clock += 10),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...overrides,
  };
  const calls = (id: ProviderId) => fakes[id]?.requests.length ?? 0;
  return { deps, fakes, states, sleeps, calls };
}

const run = (h: ReturnType<typeof harness>, job: "code_qa" | "code_review" = "code_qa") =>
  runJob(h.deps, job, job === "code_qa" ? QUESTION : { mode: "review", path: "src/tasks/store.ts" }, { signal: new AbortController().signal });

describe("the first choice", () => {
  it("answers without any fallback when the selected provider works", async () => {
    const h = harness(ALL, { groq: [{ text: answer(), usage: USAGE }], gemini: [], openrouter: [] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.provider, "groq");
    assert.equal(outcome.model, "openai/gpt-oss-20b");
    assert.equal(outcome.category, "simple_qa");
    assert.equal(outcome.fallback, false);
    assert.equal(outcome.attempts, 1);
    assert.equal(h.calls("gemini") + h.calls("openrouter"), 0, "no other provider is called");
    assert.deepEqual(outcome.attemptLog.map((a) => a.outcome), ["ok"]);
    assert.match(outcome.routeReason ?? "", /latency|price/);
  });

  it("skips a provider with no API key and never calls it", async () => {
    const h = harness({ ...ALL, GROQ_API_KEY: undefined }, { gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "gemini");
    assert.equal(outcome.fallback, false, "gemini is the first ELIGIBLE provider, so this is not a fallback");
    assert.equal(h.calls("groq"), 0);
  });

  it("fails with a clear configuration error when no provider has a key, without any call", async () => {
    const h = harness({}, {});
    const outcome = await run(h);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "not_configured");
    assert.match(outcome.error?.message ?? "", /GROQ_API_KEY/);
    assert.equal(outcome.result, undefined);
  });
});

describe("failover", () => {
  it("moves to the next provider when the first stays unavailable (Groq down, Gemini answers)", async () => {
    const h = harness(ALL, { groq: [down(), down(), down()], gemini: [{ text: answer(), usage: USAGE }], openrouter: [] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.provider, "gemini");
    assert.equal(outcome.fallback, true);
    assert.equal(h.calls("groq"), 3, "bounded retries on the failing provider");
    assert.equal(h.calls("openrouter"), 0);
    assert.deepEqual(outcome.attemptLog.map((a) => `${a.provider}:${a.outcome}`), ["groq:unavailable", "groq:unavailable", "groq:unavailable", "gemini:ok"]);
    assert.equal(outcome.attempts, 4);
  });

  it("keeps going down the order: Groq fails, Gemini fails, OpenRouter answers", async () => {
    const h = harness(ALL, { groq: [down(), down(), down()], gemini: [down(), down(), down()], openrouter: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.provider, "openrouter");
    assert.deepEqual([h.calls("groq"), h.calls("gemini"), h.calls("openrouter")], [3, 3, 1]);
  });

  it("falls back from Gemini to another provider once both of its tiers fail", async () => {
    const h = harness(ALL, { gemini: [down(), down(), down(), down(), down(), down()], groq: [{ text: review(), usage: USAGE }] });
    const outcome = await run(h, "code_review");
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.category, "repository_analysis");
    assert.equal(outcome.provider, "groq");
    assert.equal(outcome.model, "openai/gpt-oss-120b");
    assert.equal(h.calls("gemini"), 6);
  });

  it("does not wait out a rate limit when another provider can answer", async () => {
    const h = harness(ALL, { groq: [new LlmError("rate_limited", "429", 30)], gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "gemini");
    assert.deepEqual(h.sleeps, [], "no backoff sleep");
    assert.equal(h.calls("groq"), 1);
  });

  it("waits out a rate limit with Retry-After when it is the only provider", async () => {
    const h = harness({ GROQ_API_KEY: "q".repeat(20) }, { groq: [new LlmError("rate_limited", "429", 3), { text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.deepEqual(h.sleeps, [3000]);
    assert.equal(outcome.fallback, false);
  });

  it("treats a quota failure as a reason to move on, not to retry", async () => {
    const h = harness(ALL, { groq: [new LlmError("quota", "daily")], gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "gemini");
    assert.equal(h.calls("groq"), 1);
  });

  it("falls over on a malformed provider response (bad_output) and on a timeout", async () => {
    const h = harness(ALL, { groq: [new LlmError("bad_output", "empty")], gemini: [new LlmError("timeout", "slow")], openrouter: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "openrouter");
    assert.deepEqual(outcome.attemptLog.map((a) => a.outcome), ["bad_output", "timeout", "ok"]);
  });

  it("skips an unsupported model without retrying it", async () => {
    const h = harness(ALL, { groq: [new LlmError("unsupported_model", "gone")], gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "gemini");
    assert.equal(h.calls("groq"), 1);
  });

  it("does not move to another model after a safety block", async () => {
    const h = harness(ALL, { groq: [{ text: "x", finishReason: "safety" }], gemini: [], openrouter: [] });
    const outcome = await run(h);
    assert.equal(outcome.error?.category, "safety_blocked");
    assert.equal(h.calls("gemini") + h.calls("openrouter"), 0);
  });
});

describe("credentials and context", () => {
  it("does not retry invalid credentials: one call, then the next provider", async () => {
    const h = harness(ALL, { groq: [new LlmError("auth", "401")], gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.provider, "gemini");
    assert.equal(h.calls("groq"), 1);
    assert.deepEqual(h.sleeps, []);
  });

  it("fails honestly with an auth error when the only provider's key is rejected, after one call", async () => {
    const h = harness({ GROQ_API_KEY: "q".repeat(20) }, { groq: [new LlmError("auth", "401")] });
    const outcome = await run(h);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "auth");
    assert.equal(h.calls("groq"), 1);
  });

  it("does not return to a provider that was rejected earlier in the same run", async () => {
    const toolCall = { toolCalls: [{ id: "1", name: "read_file", args: { path: "src/tasks/store.ts", startLine: 1, endLine: 5 } }], usage: USAGE };
    const h = harness(ALL, { groq: [new LlmError("auth", "401")], gemini: [toolCall, { text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(h.calls("groq"), 1, "the second model call of the tool loop does not try Groq again");
    assert.equal(h.calls("gemini"), 2);
    assert.equal(outcome.turns, 2);
  });

  it("remembers a rejected key across runs through the cooldowns", async () => {
    const cooldowns = new Cooldowns(() => 0);
    const first = harness(ALL, { groq: [new LlmError("auth", "401")], gemini: [{ text: answer(), usage: USAGE }] }, { cooldowns });
    await run(first);
    const second = harness(ALL, { groq: [{ text: answer(), usage: USAGE }], gemini: [{ text: answer(), usage: USAGE }] }, { cooldowns });
    const outcome = await run(second);
    assert.equal(second.calls("groq"), 0, "Groq is not tried while its key is known to be rejected");
    assert.equal(outcome.provider, "gemini");
    assert.equal(outcome.fallback, false);
  });

  it("moves a context overflow to a provider with a larger window, and fails clearly when there is none", async () => {
    const h = harness(ALL, { groq: [new LlmError("context_overflow", "too long")], gemini: [{ text: answer(), usage: USAGE }] });
    assert.equal((await run(h)).provider, "gemini");
    const alone = harness({ GROQ_API_KEY: "q".repeat(20) }, { groq: [new LlmError("context_overflow", "too long")] });
    const outcome = await run(alone);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "context_overflow");
    assert.equal(alone.calls("groq"), 1);
  });
});

describe("failing everywhere", () => {
  it("returns a genuine failure with no answer, and respects the retry limit on every provider", async () => {
    const h = harness(ALL, { groq: [down(), down(), down()], gemini: [down(), down(), down()], openrouter: [down(), down(), down()] });
    const outcome = await run(h);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "unavailable");
    assert.equal(outcome.result, undefined, "no fabricated answer");
    assert.deepEqual([h.calls("groq"), h.calls("gemini"), h.calls("openrouter")], [3, 3, 3]);
    assert.equal(outcome.attempts, 9);
    assert.equal(outcome.usageReported, false, "nothing succeeded, so no usage was reported");
    assert.equal(outcome.provider, undefined);
    assert.ok(outcome.attemptLog.every((a) => a.outcome === "unavailable" && !a.usageReported));
  });

  it("reports the last failure's kind", async () => {
    const h = harness(ALL, { groq: [new LlmError("auth", "401")], gemini: [new LlmError("auth", "403")], openrouter: [new LlmError("quota", "402")] });
    assert.equal((await run(h)).error?.category, "quota");
  });
});

describe("what is recorded", () => {
  it("adds up only the usage of successful calls, and keeps the failed attempts in the log without tokens", async () => {
    const h = harness(ALL, { groq: [down(), down(), down()], gemini: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.deepEqual(outcome.usage, USAGE);
    assert.equal(outcome.usageReported, true);
    assert.equal(outcome.attemptLog.filter((a) => a.outcome !== "ok" && a.usageReported).length, 0);
  });

  it("sums the usage of every successful call of a tool loop, across providers", async () => {
    const toolCall = { toolCalls: [{ id: "1", name: "read_file", args: { path: "src/tasks/store.ts", startLine: 1, endLine: 5 } }], usage: USAGE };
    let seenByGemini: string[] = [];
    const final: FakeStep = (request) => {
      seenByGemini = request.turns.map((t) => t.role);
      return { text: answer(), usage: USAGE };
    };
    const h = harness(ALL, { groq: [toolCall, down(), down(), down()], gemini: [final] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.usage.inputTokens, 1800);
    assert.equal(outcome.turns, 2);
    assert.equal(outcome.fallback, true);
    assert.deepEqual(seenByGemini, ["user", "model", "tool"], "the new provider receives the whole exchange so far");
  });

  it("marks usage as not reported when a provider sent none, and cost as unknown rather than free", async () => {
    const h = harness({ OPENROUTER_API_KEY: "o".repeat(20) }, { openrouter: [{ text: answer(), usageReported: false }] });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.usageReported, false);
    assert.equal(outcome.costKnown, false, "OpenRouter has no price table and reported no cost");
  });

  it("uses the cost a provider reports itself", async () => {
    const h = harness({ OPENROUTER_API_KEY: "o".repeat(20) }, { openrouter: [{ text: answer(), usage: USAGE, costUsd: 0.0021 }] });
    const outcome = await run(h);
    assert.equal(outcome.costUsd, 0.0021);
    assert.equal(outcome.costKnown, true);
  });

  it("prices Groq and Gemini calls from the tabulated prices", async () => {
    const h = harness({ GROQ_API_KEY: "q".repeat(20) }, { groq: [{ text: answer(), usage: { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, thinkingTokens: 0 } }] });
    const outcome = await run(h);
    assert.equal(outcome.costUsd, 0.375, "0.075 in + 0.30 out per 1M tokens for gpt-oss-20b");
    assert.equal(outcome.costKnown, true);
  });

  it("records a whole-snapshot baseline estimate and the techniques that were actually applied", async () => {
    const h = harness(ALL, { groq: [{ text: answer(), usage: USAGE }] });
    const outcome = await run(h);
    assert.equal(outcome.baselineTokensEstimate, Math.ceil(STORE.length / 4));
    assert.ok(outcome.techniques.includes("retrieval-based context selection"));
    assert.ok(!outcome.techniques.includes("on-demand tool reads"), "no tool was called");
    assert.ok(!outcome.techniques.includes("provider prompt caching"), "nothing was cached");
  });

  it("does not add records or states because of a fallback: the lifecycle is the same as without one", async () => {
    const clean = harness(ALL, { groq: [{ text: answer(), usage: USAGE }] });
    await run(clean);
    const failed = harness(ALL, { groq: [down(), down(), down()], gemini: [{ text: answer(), usage: USAGE }] });
    await run(failed);
    assert.deepEqual(failed.states, clean.states);
    assert.equal(failed.states.filter((s) => s === "completed").length, 1);
  });

  it("emits route, retry and fallback events with provider names and no secrets", async () => {
    const events: unknown[] = [];
    const h = harness(ALL, { groq: [down(), down(), down()], gemini: [{ text: answer(), usage: USAGE }] }, { onEvent: (e) => events.push(e) });
    await run(h);
    const text = JSON.stringify(events);
    assert.match(text, /"type":"route".*"provider":"groq"/);
    assert.match(text, /"type":"fallback".*"fromProvider":"groq".*"toProvider":"gemini"/);
    assert.ok(!text.includes(ALL.GROQ_API_KEY) && !text.includes(ALL.GEMINI_API_KEY));
  });
});

// ---------------------------------------------------------------- the real adapters over mocked HTTP

describe("assistant flow over mocked HTTP (real adapters, no network)", () => {
  type Seen = { url: string; auth: string | undefined; model: string };
  function http(responses: Record<string, (Response | Error)[]>) {
    const seen: Seen[] = [];
    const make = (name: "groq" | "openrouter", baseUrl: string, key: string) =>
      createOpenAiCompatibleProvider({
        name,
        baseUrl,
        apiKey: key,
        fetchImpl: async (url, init) => {
          const body = JSON.parse(init.body);
          seen.push({ url, auth: init.headers.Authorization, model: body.model });
          const next = responses[name].shift();
          if (!next) throw new Error("unscripted call");
          if (next instanceof Error) throw next;
          return next;
        },
      });
    return { seen, providers: { groq: make("groq", "https://api.groq.com/openai/v1", ALL.GROQ_API_KEY), openrouter: make("openrouter", "https://openrouter.ai/api/v1", ALL.OPENROUTER_API_KEY) } };
  }
  const reply = (content: string, usage: Record<string, unknown> | undefined) => new Response(JSON.stringify({ model: "m", choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }], usage }), { status: 200 });

  it("answers from OpenRouter, with its own reported cost, after Groq returns server errors", async () => {
    const net = http({
      groq: [new Response("{}", { status: 503 }), new Response("{}", { status: 503 }), new Response("{}", { status: 503 })],
      openrouter: [reply(answer(), { prompt_tokens: 1200, completion_tokens: 80, cost: 0.0009 })],
    });
    const h = harness({ GROQ_API_KEY: ALL.GROQ_API_KEY, OPENROUTER_API_KEY: ALL.OPENROUTER_API_KEY }, {}, { providers: net.providers });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal((outcome.result as { answer: string }).answer, "findOverdue is on line 2.");
    assert.equal(outcome.provider, "openrouter");
    assert.equal(outcome.fallback, true);
    assert.deepEqual(net.seen.map((s) => new URL(s.url).host), ["api.groq.com", "api.groq.com", "api.groq.com", "openrouter.ai"]);
    assert.equal(net.seen[3].auth, `Bearer ${ALL.OPENROUTER_API_KEY}`);
    assert.equal(net.seen[3].model, "openai/gpt-oss-20b");
    assert.deepEqual(outcome.usage, { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 0, thinkingTokens: 0 });
    assert.equal(outcome.costUsd, 0.0009);
    assert.equal(outcome.usageReported, true);
  });

  it("corrects once with the schema when a model answers in prose, then succeeds", async () => {
    const net = http({ groq: [reply("Sure! It is in store.ts.", { prompt_tokens: 500, completion_tokens: 20 }), reply(answer(), { prompt_tokens: 600, completion_tokens: 60 })], openrouter: [] });
    const h = harness({ GROQ_API_KEY: ALL.GROQ_API_KEY }, {}, { providers: { groq: net.providers.groq } });
    const outcome = await run(h);
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.turns, 2);
    assert.equal(outcome.usage.inputTokens, 1100);
  });

  it("fails with a user-safe message and no answer when every provider is rejected", async () => {
    const net = http({ groq: [new Response(JSON.stringify({ error: { message: `bad key ${ALL.GROQ_API_KEY}` } }), { status: 401 })], openrouter: [new Response("{}", { status: 401 })] });
    const h = harness({ GROQ_API_KEY: ALL.GROQ_API_KEY, OPENROUTER_API_KEY: ALL.OPENROUTER_API_KEY }, {}, { providers: net.providers });
    const outcome = await run(h);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "auth");
    assert.equal(outcome.result, undefined);
    const shown = JSON.stringify(outcome.error);
    assert.ok(!shown.includes(ALL.GROQ_API_KEY) && !shown.includes(ALL.OPENROUTER_API_KEY), "no key in the message that reaches the user");
    assert.match(shown, /provider keys/);
  });
});
