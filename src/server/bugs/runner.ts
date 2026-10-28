import { type RawFinding, type StoredFinding, verifyFindings } from "@/lib/bugs/findings";
import type { ScanUnit } from "@/lib/bugs/scan";

// Runs the pending batches of one bug scan, one AI run per batch, and stores what each batch found. Pure orchestration
// over injected dependencies, so the scheduling rules are tested without a database or a model (runner.test.ts).
// Resumable by construction: the scan row says which batches are done or failed; this only touches the rest.

export type BatchOutcome =
  | { ok: true; findings: RawFinding[]; inputTokens: number; outputTokens: number; costUsd: number }
  | { ok: false; category: string; message: string; inputTokens: number; outputTokens: number; costUsd: number };

export type RunnerDeps = {
  now(): number;
  runBatch(units: ScanUnit[], signal: AbortSignal): Promise<BatchOutcome | "cancelled">;
  readText(path: string): Promise<string | null>;
  record(args: { batchIndex: number; findings: StoredFinding[]; failed: boolean; error: string | null; inputTokens: number; outputTokens: number; costUsd: number }): Promise<void>;
};

export type RunnerScan = { batches: { units: ScanUnit[] }[]; completed: readonly number[]; failed: readonly number[] };
export type RunnerResult = {
  processed: number;
  stopped: "finished" | "deadline" | "cancelled" | "provider";
  found: number;
  dropped: number;
};

// Failures of the provider itself (bad key, spent quota) will repeat on every batch: stop instead of burning through the plan.
const STOP_ON = new Set(["auth", "quota", "not_configured", "disabled"]);
// Reserve for one more batch: the orchestrator's own deadline is 120 s.
const BATCH_RESERVE_MS = 125_000;

export async function runPendingBatches(deps: RunnerDeps, scan: RunnerScan, options: { deadlineAt: number; signal: AbortSignal }): Promise<RunnerResult> {
  const result: RunnerResult = { processed: 0, stopped: "finished", found: 0, dropped: 0 };
  for (let index = 0; index < scan.batches.length; index++) {
    if (scan.completed.includes(index) || scan.failed.includes(index)) continue;
    if (options.signal.aborted) return { ...result, stopped: "cancelled" };
    if (deps.now() + BATCH_RESERVE_MS > options.deadlineAt) return { ...result, stopped: "deadline" };
    const units = scan.batches[index].units;
    const paths = [...new Set(units.map((u) => u.path))];
    const outcome = await deps.runBatch(units, options.signal);
    if (outcome === "cancelled") return { ...result, stopped: "cancelled" };
    if (!outcome.ok) {
      await deps.record({ batchIndex: index, findings: [], failed: true, error: `${outcome.category}: ${outcome.message}`.slice(0, 500), ...tokens(outcome) });
      result.processed++;
      if (STOP_ON.has(outcome.category)) return { ...result, stopped: "provider" };
      continue;
    }
    const { stored, dropped } = await verifyFindings(outcome.findings, new Set(paths), deps.readText);
    await deps.record({ batchIndex: index, findings: stored, failed: false, error: null, ...tokens(outcome) });
    result.processed++;
    result.found += stored.length;
    result.dropped += Object.values(dropped).reduce((a, b) => a + b, 0);
  }
  return result;
}

function tokens(o: { inputTokens: number; outputTokens: number; costUsd: number }) {
  return { inputTokens: o.inputTokens, outputTokens: o.outputTokens, costUsd: o.costUsd };
}
