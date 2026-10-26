// Unit tests for the deterministic parts of the AI orchestrator: lifecycle, retry policy, token budget, routing and
// the model registry. No network, no database.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateTokens, inputBudget } from "./budget";
import { modelRegistry } from "./models";
import { backoffMillis, isRetryable } from "./retry";
import { classifyAsk, chooseTier } from "./router";
import { TERMINAL_STATES, canTransition } from "./state";

describe("run lifecycle", () => {
  it("allows the normal path and the tool loop", () => {
    const path = ["queued", "validating", "retrieving_context", "generating", "executing_tool", "generating", "validating_output", "completed"] as const;
    for (let i = 1; i < path.length; i++) assert.equal(canTransition(path[i - 1], path[i]), true, `${path[i - 1]} -> ${path[i]}`);
  });

  it("allows one correction turn from validating_output back to generating", () => {
    assert.equal(canTransition("validating_output", "generating"), true);
  });

  it("lets every active state fail or be cancelled, and model work time out", () => {
    for (const state of ["queued", "validating", "retrieving_context", "generating", "executing_tool", "validating_output"] as const) {
      assert.equal(canTransition(state, "failed"), true, state);
      assert.equal(canTransition(state, "cancelled"), true, state);
    }
    for (const state of ["retrieving_context", "generating", "executing_tool", "validating_output"] as const) {
      assert.equal(canTransition(state, "timed_out"), true, state);
    }
  });

  it("refuses skipping steps and leaving a terminal state", () => {
    assert.equal(canTransition("queued", "generating"), false);
    assert.equal(canTransition("validating", "completed"), false);
    assert.equal(canTransition("executing_tool", "completed"), false);
    for (const state of TERMINAL_STATES) {
      for (const next of ["queued", "generating", "completed", "failed"] as const) assert.equal(canTransition(state, next), false, `${state} -> ${next}`);
    }
  });
});

describe("retry policy", () => {
  it("retries only transient categories", () => {
    for (const category of ["rate_limited", "unavailable", "network"] as const) assert.equal(isRetryable(category), true, category);
    for (const category of ["auth", "quota", "invalid_request", "context_overflow", "safety_blocked", "bad_output", "timeout"] as const) {
      assert.equal(isRetryable(category), false, category);
    }
  });

  it("backs off exponentially with bounded jitter", () => {
    const noJitter = () => 0;
    assert.equal(backoffMillis(0, undefined, noJitter), 1000);
    assert.equal(backoffMillis(1, undefined, noJitter), 2000);
    assert.equal(backoffMillis(2, undefined, noJitter), 4000);
    const fullJitter = () => 0.999;
    assert.ok(backoffMillis(0, undefined, fullJitter) < 1500, "jitter adds less than 50%");
  });

  it("honours Retry-After but caps it", () => {
    assert.equal(backoffMillis(0, 7, () => 0), 7000);
    assert.equal(backoffMillis(0, 600, () => 0), 20_000);
  });
});

describe("token budget", () => {
  it("estimates about four characters per token, rounding up", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("abcde"), 2);
  });

  it("reserves output and a safety margin, and never exceeds the job budget", () => {
    assert.equal(inputBudget({ contextLimit: 1_000_000, reservedOutput: 8000, jobBudget: 24_000 }), 24_000);
    assert.equal(inputBudget({ contextLimit: 30_000, reservedOutput: 8000, jobBudget: 24_000 }), 30_000 - 8000 - 1500);
    assert.equal(inputBudget({ contextLimit: 5000, reservedOutput: 8000, jobBudget: 24_000 }), 0);
  });
});

describe("routing", () => {
  it("recognises stack traces and error logs as bug explanations", () => {
    assert.equal(classifyAsk("TypeError: Cannot read properties of undefined (reading 'id')\n    at TaskStore.complete (src/tasks/store.ts:24:10)"), "explain_error");
    assert.equal(classifyAsk('Traceback (most recent call last):\n  File "scripts/report.py", line 9, in summarize'), "explain_error");
  });

  it("recognises requests to write tests or documentation", () => {
    assert.equal(classifyAsk("Write unit tests for findOverdue"), "generate_tests");
    assert.equal(classifyAsk("generate docs for the priority module"), "generate_docs");
  });

  it("treats everything else as a question", () => {
    assert.equal(classifyAsk("Where is the session expiry checked?"), "question");
    assert.equal(classifyAsk("How are tasks sorted?"), "question");
  });

  it("uses the fast tier only for short questions with small context", () => {
    assert.equal(chooseTier({ job: "code_qa", promptChars: 80, contextTokens: 3000 }), "fast");
    assert.equal(chooseTier({ job: "code_qa", promptChars: 600, contextTokens: 3000 }), "standard");
    assert.equal(chooseTier({ job: "code_qa", promptChars: 80, contextTokens: 9000 }), "standard");
    assert.equal(chooseTier({ job: "code_review", promptChars: 10, contextTokens: 100 }), "standard");
    assert.equal(chooseTier({ job: "requirement_trace", promptChars: 10, contextTokens: 100 }), "standard");
  });
});

describe("model registry", () => {
  it("is not configured without an API key", () => {
    assert.equal(modelRegistry({}).configured, false);
    assert.equal(modelRegistry({ GEMINI_API_KEY: "  " }).configured, false);
  });

  it("uses the documented defaults and lets the environment override model ids", () => {
    const defaults = modelRegistry({ GEMINI_API_KEY: "k".repeat(39) });
    assert.equal(defaults.configured, true);
    assert.equal(defaults.models.fast.id, "gemini-3.5-flash-lite");
    assert.equal(defaults.models.standard.id, "gemini-3.8-flash");
    assert.equal(defaults.models.deep, undefined);
    const custom = modelRegistry({ GEMINI_API_KEY: "k".repeat(39), AI_MODEL_STANDARD: "gemini-x", AI_MODEL_DEEP: "gemini-4-argon" });
    assert.equal(custom.models.standard.id, "gemini-x");
    assert.equal(custom.models.deep?.id, "gemini-4-argon");
  });

  it("falls back from standard to fast but never silently up to the paid deep tier", () => {
    const registry = modelRegistry({ GEMINI_API_KEY: "k".repeat(39), AI_MODEL_DEEP: "gemini-4-argon" });
    assert.deepEqual(registry.fallbackChain("standard"), ["standard", "fast"]);
    assert.deepEqual(registry.fallbackChain("fast"), ["fast"]);
  });

  it("estimates cost from configured prices, including cached input", () => {
    const registry = modelRegistry({ GEMINI_API_KEY: "k".repeat(39) });
    const cost = registry.estimateCostUsd("standard", { inputTokens: 1_000_000, outputTokens: 1_000_000, cachedInputTokens: 0, thinkingTokens: 0 });
    assert.equal(cost, 0.75 + 3.75);
    const cached = registry.estimateCostUsd("standard", { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 1_000_000, thinkingTokens: 0 });
    assert.equal(cached, 0.075);
  });
});
