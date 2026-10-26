// Orchestrator behaviour with a scripted provider and an in-memory snapshot: lifecycle, tool loop, output validation
// and correction, retries, fallback, limits, cancellation and deadlines. No network, no database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelRegistry } from "./models";
import { type OrchestratorDeps, ORCHESTRATOR_LIMITS, runJob } from "./orchestrator";
import { FakeProvider, type FakeStep } from "./provider/fake";
import { LlmError } from "./provider/types";
import { memoryReader } from "./test-support";
import type { RunState } from "./types";

const STORE = ["export class TaskStore {", "  findOverdue(now: Date) {", "    return [];", "  }", "}"].join("\n");
const KEY = { GEMINI_API_KEY: "k".repeat(39) };

function harness(steps: FakeStep[], overrides: Partial<OrchestratorDeps> & { files?: Record<string, string>; clockStep?: number } = {}) {
  const states: RunState[] = [];
  const sleeps: number[] = [];
  let clock = 0;
  const provider = new FakeProvider(steps);
  const deps: OrchestratorDeps = {
    provider,
    registry: modelRegistry(KEY),
    reader: memoryReader(overrides.files ?? { "src/tasks/store.ts": STORE }),
    store: { transition: async (state) => void states.push(state), cancelRequested: async () => false },
    now: () => (clock += overrides.clockStep ?? 10),
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0,
    ...overrides,
  };
  return { deps, provider, states, sleeps };
}

const answer = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ answer: "findOverdue is on line 2.", citations: [{ path: "src/tasks/store.ts", startLine: 2, endLine: 4 }], confidence: "high", missingContext: [], ...extra });

const signal = () => new AbortController().signal;

describe("runJob", () => {
  it("completes a question with one tool call, recording states, usage and cost", async () => {
    const h = harness([
      { toolCalls: [{ id: "1", name: "read_file", args: { path: "src/tasks/store.ts", startLine: 1, endLine: 5 } }], usage: { inputTokens: 1000, outputTokens: 20, cachedInputTokens: 0, thinkingTokens: 0 } },
      { text: answer(), usage: { inputTokens: 1200, outputTokens: 80, cachedInputTokens: 400, thinkingTokens: 10 } },
    ]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(h.states, ["validating", "retrieving_context", "generating", "executing_tool", "generating", "validating_output", "completed"]);
    assert.deepEqual(outcome.usage, { inputTokens: 2200, outputTokens: 100, cachedInputTokens: 400, thinkingTokens: 10 });
    assert.equal(outcome.turns, 2);
    assert.equal(outcome.toolCalls, 1);
    assert.equal(outcome.tier, "fast");
    assert.ok(outcome.costUsd > 0);
    assert.deepEqual((outcome.result as { citations: unknown }).citations, [{ path: "src/tasks/store.ts", startLine: 2, endLine: 4 }]);
    // The tool result went back to the model in the second request.
    const second = h.provider.requests[1];
    assert.equal(second.turns[2].role, "tool");
  });

  it("drops citations that point outside the snapshot or past the end of a file", async () => {
    const h = harness([{ text: answer({ citations: [{ path: "src/tasks/store.ts", startLine: 2, endLine: 4 }, { path: "src/tasks/store.ts", startLine: 3, endLine: 99 }, { path: "src/fake.ts", startLine: 1, endLine: 1 }] }) }]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.citationsDropped, 2);
    assert.equal((outcome.result as { citations: unknown[] }).citations.length, 1);
  });

  it("fails clearly when no API key is configured, without calling the provider", async () => {
    const h = harness([], { registry: modelRegistry({}) });
    const outcome = await runJob(h.deps, "code_qa", { question: "Where?" + "x".repeat(5) }, { signal: signal() });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "not_configured");
    assert.equal(h.provider.requests.length, 0);
  });

  it("rejects invalid input before any work", async () => {
    const h = harness([]);
    const outcome = await runJob(h.deps, "code_qa", { question: "" }, { signal: signal() });
    assert.equal(outcome.error?.category, "invalid_input");
    assert.equal(h.provider.requests.length, 0);
  });

  it("fails when the snapshot has no stored source text", async () => {
    const h = harness([], { files: {} });
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue?" }, { signal: signal() });
    assert.equal(outcome.error?.category, "no_source");
  });

  it("asks once for a corrected reply when the output is not valid JSON, with the schema and no tools", async () => {
    const h = harness([{ text: "Sure! It is in store.ts." }, { text: answer() }]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    const correction = h.provider.requests[1];
    assert.ok(correction.responseJsonSchema, "schema requested");
    assert.equal(correction.tools, undefined, "no tools on the correction turn");
    assert.deepEqual(h.states.slice(-4), ["validating_output", "generating", "validating_output", "completed"]);
  });

  it("fails with bad_output when the corrected reply is still invalid", async () => {
    const h = harness([{ text: "nope" }, { text: '{"answer": 5}' }]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.error?.category, "bad_output");
  });

  it("retries a rate-limited call with the provider's Retry-After", async () => {
    const h = harness([new LlmError("rate_limited", "429", 3), { text: answer() }]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.deepEqual(h.sleeps, [3000]);
    assert.equal(outcome.attempts, 2);
  });

  it("does not retry an authentication error", async () => {
    const h = harness([new LlmError("auth", "401")]);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.error?.category, "auth");
    assert.equal(h.provider.requests.length, 1);
  });

  it("falls back to the cheaper tier after the standard model stays unavailable, and says so", async () => {
    const down = new LlmError("unavailable", "503");
    const h = harness([down, down, down, { text: JSON.stringify({ summary: "ok", findings: [], confidence: "low", missingContext: [] }) }]);
    const outcome = await runJob(h.deps, "code_review", { mode: "review", path: "src/tasks/store.ts" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.fallback, true);
    assert.equal(outcome.tier, "fast");
    assert.equal(h.provider.requests[3].model, "gemini-3.5-flash-lite");
  });

  it("stops offering tools after the tool-call limit and asks for an answer", async () => {
    const call = { toolCalls: [{ name: "search_code", args: { query: "Task" } }] };
    const steps: FakeStep[] = Array.from({ length: ORCHESTRATOR_LIMITS.maxToolCalls }, () => call);
    steps.push((request) => (request.tools ? call : { text: answer() }));
    const h = harness(steps);
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.toolCalls, ORCHESTRATOR_LIMITS.maxToolCalls);
    assert.equal(h.provider.requests.at(-1)?.tools, undefined);
  });

  it("stops when the user cancels, without further model calls", async () => {
    let checks = 0;
    const h = harness([{ toolCalls: [{ name: "search_code", args: { query: "Task" } }] }, { text: answer() }], {
      store: { transition: async () => {}, cancelRequested: async () => ++checks > 3 },
    });
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal() });
    assert.equal(outcome.status, "cancelled");
    assert.equal(h.provider.requests.length, 1);
  });

  it("times out at the deadline", async () => {
    const h = harness([{ toolCalls: [{ name: "search_code", args: { query: "Task" } }] }, { text: answer() }], { clockStep: 30_000 });
    const outcome = await runJob(h.deps, "code_qa", { question: "Where is findOverdue defined?" }, { signal: signal(), deadlineMs: 90_000 });
    assert.equal(outcome.status, "timed_out");
  });

  it("checks generated tests for syntax and asks once for a fix", async () => {
    const generated = (content: string) =>
      JSON.stringify({ kind: "tests", language: "TypeScript", filename: "store.test.ts", content, notes: "", citations: [], confidence: "medium", missingContext: [] });
    let checks = 0;
    const h = harness([{ text: generated("test(") }, { text: generated("test('x', () => {});") }], {
      syntaxCheck: async () => ++checks > 1,
    });
    const outcome = await runJob(h.deps, "generate", { kind: "tests", path: "src/tasks/store.ts" }, { signal: signal() });
    assert.equal(outcome.status, "completed");
    assert.equal(outcome.syntaxValid, true);
    assert.equal(h.provider.requests.length, 2);
  });
});
