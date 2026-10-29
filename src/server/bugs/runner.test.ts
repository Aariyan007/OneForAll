import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawFinding } from "@/lib/bugs/findings";
import { type BatchOutcome, type RunnerDeps, runPendingBatches } from "./runner";

const TEXT = "function f() {\n  return a.b.c;\n}";
const finding: RawFinding = {
  title: "t", category: "backend", severity: "low", severityReason: "r", path: "a.ts", startLine: 2, endLine: 2,
  description: "d", evidence: "return a.b.c;", confidence: 0.6, suggestedFix: "", validationSteps: "",
};
const ok = (findings: RawFinding[]): BatchOutcome => ({ ok: true, findings, inputTokens: 100, outputTokens: 20, costUsd: 0.001 });

function harness(outcomes: (BatchOutcome | "cancelled")[], clock = { t: 0, step: 1000 }) {
  const recorded: { batchIndex: number; failed: boolean; n: number; error: string | null }[] = [];
  const ran: unknown[] = [];
  const deps: RunnerDeps = {
    now: () => (clock.t += clock.step),
    runBatch: async (units) => {
      ran.push(units);
      return outcomes.shift() ?? ok([]);
    },
    readText: async (p) => (p === "a.ts" ? TEXT : null),
    record: async (a) => void recorded.push({ batchIndex: a.batchIndex, failed: a.failed, n: a.findings.length, error: a.error }),
  };
  return { deps, recorded, ran };
}
const far = () => ({ deadlineAt: Number.MAX_SAFE_INTEGER, signal: new AbortController().signal });
const plan = (n: number) => Array.from({ length: n }, () => ({ units: [{ path: "a.ts" }] }));

test("every pending batch runs once and verified findings are recorded", async () => {
  const h = harness([ok([finding]), ok([])]);
  const r = await runPendingBatches(h.deps, { batches: plan(2), completed: [], failed: [] }, far());
  assert.deepEqual(r, { processed: 2, stopped: "finished", found: 1, dropped: 0 });
  assert.deepEqual(h.recorded.map((x) => [x.batchIndex, x.failed, x.n]), [[0, false, 1], [1, false, 0]]);
});

test("a resumed scan skips finished and failed batches", async () => {
  const h = harness([ok([])]);
  const r = await runPendingBatches(h.deps, { batches: plan(4), completed: [0, 1], failed: [3] }, far());
  assert.equal(r.processed, 1);
  assert.deepEqual(h.recorded.map((x) => x.batchIndex), [2]);
});

test("findings that fail verification are dropped and counted, not stored", async () => {
  const h = harness([ok([finding, { ...finding, evidence: "return invented();" }])]);
  const r = await runPendingBatches(h.deps, { batches: plan(1), completed: [], failed: [] }, far());
  assert.equal(r.found, 1);
  assert.equal(r.dropped, 1);
});

test("a failed batch is recorded as failed and the scan goes on", async () => {
  const h = harness([{ ok: false, category: "unavailable", message: "down", inputTokens: 0, outputTokens: 0, costUsd: 0 }, ok([])]);
  const r = await runPendingBatches(h.deps, { batches: plan(2), completed: [], failed: [] }, far());
  assert.equal(r.stopped, "finished");
  assert.deepEqual(h.recorded.map((x) => [x.batchIndex, x.failed]), [[0, true], [1, false]]);
  assert.match(h.recorded[0].error ?? "", /unavailable/);
});

test("a spent quota stops the scan instead of failing every remaining batch", async () => {
  const h = harness([{ ok: false, category: "quota", message: "used up", inputTokens: 0, outputTokens: 0, costUsd: 0 }]);
  const r = await runPendingBatches(h.deps, { batches: plan(5), completed: [], failed: [] }, far());
  assert.equal(r.stopped, "provider");
  assert.equal(h.ran.length, 1);
  assert.equal(h.recorded.length, 1);
});

test("it stops before a batch that cannot finish within the deadline", async () => {
  const h = harness([ok([]), ok([])], { t: 0, step: 1 });
  const r = await runPendingBatches(h.deps, { batches: plan(3), completed: [], failed: [] }, { deadlineAt: 100_000, signal: new AbortController().signal });
  assert.equal(r.stopped, "deadline");
  assert.equal(h.ran.length, 0);
});

test("cancellation leaves the interrupted batch pending (nothing is recorded for it)", async () => {
  const h = harness(["cancelled"]);
  const r = await runPendingBatches(h.deps, { batches: plan(2), completed: [], failed: [] }, far());
  assert.equal(r.stopped, "cancelled");
  assert.equal(h.recorded.length, 0);
  const aborted = new AbortController();
  aborted.abort();
  const h2 = harness([]);
  assert.equal((await runPendingBatches(h2.deps, { batches: plan(2), completed: [], failed: [] }, { deadlineAt: Infinity, signal: aborted.signal })).stopped, "cancelled");
});
