import "server-only";
import { createClient } from "@/lib/supabase/server";
import { planScan, type ScanFile, type ScanUnit } from "@/lib/bugs/scan";
import type { Json } from "@/types/database";
import type { BugScanOutput } from "@/server/ai/jobs";
import { executeRun, startRun } from "@/server/ai/service";
import { createSnapshotReader } from "@/server/ai/supabase";
import type { GraphAccess } from "@/server/repository-graph/queries";
import type { ProjectGraphData } from "@/server/repository-graph/project";
import { type BatchOutcome, type RunnerDeps, runPendingBatches } from "./runner";

// Bug scan: plan the files, then run the AI over them batch by batch (each batch is one orchestrated, quota-counted,
// audited AI run). Everything is read and written as the signed-in user; the database re-checks that they administer
// the organization (start_bug_scan / record_bug_scan_batch).

export type ScanRow = {
  id: string;
  status: string;
  batches_total: number;
  completed_batches: number[];
  failed_batches: number[];
  files_total: number;
  files_planned: number;
  bugs_found: number;
  bugs_new: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  plan: Json;
};

const SCAN_COLUMNS =
  "id, status, batches_total, completed_batches, failed_batches, files_total, files_planned, bugs_found, bugs_new, input_tokens, output_tokens, cost_usd, error_message, created_at, completed_at, plan";

export async function latestScan(snapshotId: string): Promise<ScanRow | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("repository_bug_scans").select(SCAN_COLUMNS).eq("snapshot_id", snapshotId).order("created_at", { ascending: false }).limit(1).maybeSingle();
  return (data as ScanRow | null) ?? null;
}

export async function getScan(scanId: string, snapshotId: string): Promise<ScanRow | null> {
  const supabase = await createClient();
  const { data } = await supabase.from("repository_bug_scans").select(SCAN_COLUMNS).eq("id", scanId).eq("snapshot_id", snapshotId).maybeSingle();
  return (data as ScanRow | null) ?? null;
}

export type StartScanResult = { ok: true; scanId: string; batches: number; filesPlanned: number; filesTotal: number } | { ok: false; status: number; error: string };

export async function createScan(snapshotId: string, graph: ProjectGraphData): Promise<StartScanResult> {
  const inDegree = new Map<string, number>();
  for (const edge of graph.edges) inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1);
  const files: ScanFile[] = graph.files.map((f) => ({ path: f.path, language: f.language, sizeBytes: f.sizeBytes, hasText: f.hasText, symbols: f.symbols, inDegree: inDegree.get(f.id) ?? 0 }));
  const plan = planScan(files);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_bug_scan", {
    p_snapshot_id: snapshotId,
    p_plan: { batches: plan.batches, skipped: plan.skipped.slice(0, 400), skippedCount: plan.skipped.length } as unknown as Json,
    p_files_total: plan.filesTotal,
    p_files_planned: plan.filesPlanned,
  });
  if (error || !data) {
    if (error?.code === "55000") return { ok: false, status: 409, error: error.message };
    if (error?.code === "42501") return { ok: false, status: 403, error: "Only organization owners and admins can scan a repository." };
    return { ok: false, status: 500, error: "The scan could not be started." };
  }
  return { ok: true, scanId: data, batches: plan.batches.length, filesPlanned: plan.filesPlanned, filesTotal: plan.filesTotal };
}

const FAILURE_BY_STATUS: Record<number, string> = { 429: "rate_limited", 503: "not_configured", 409: "disabled", 400: "invalid_input" };

// Processes pending batches until the plan is done or `budgetMs` is nearly used. Safe to call again: it continues.
export async function stepScan(scan: ScanRow, access: GraphAccess, signal: AbortSignal, budgetMs = 280_000): Promise<{ stopped: string; processed: number }> {
  const supabase = await createClient();
  const reader = await createSnapshotReader(access.snapshot.id, access.context.project.id);
  const plan = scan.plan as { batches: { units: ScanUnit[] }[] };

  const deps: RunnerDeps = {
    now: Date.now,
    readText: (path) => reader.readText(path),
    async runBatch(units, batchSignal): Promise<BatchOutcome | "cancelled"> {
      const started = await startRun(access.snapshot.id, "bug_scan", { units });
      if (!started.ok) return { ok: false, category: FAILURE_BY_STATUS[started.status] ?? "internal", message: started.error, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      const outcome = await executeRun(
        { ...started, projectId: access.context.project.id, snapshotId: access.snapshot.id, job: "bug_scan", input: { units } },
        batchSignal,
        () => undefined,
      );
      const usage = { inputTokens: outcome.usage.inputTokens, outputTokens: outcome.usage.outputTokens, costUsd: outcome.costUsd };
      if (outcome.status === "cancelled" && batchSignal.aborted) return "cancelled";
      if (outcome.status !== "completed" || !outcome.result) {
        return { ok: false, category: outcome.error?.category ?? outcome.status, message: outcome.error?.message ?? "The AI run did not complete.", ...usage };
      }
      return { ok: true, findings: (outcome.result as BugScanOutput).findings, ...usage };
    },
    async record(args) {
      const { error } = await supabase.rpc("record_bug_scan_batch", {
        p_scan_id: scan.id,
        p_batch_index: args.batchIndex,
        p_findings: args.findings as unknown as Json,
        p_failed: args.failed,
        p_input_tokens: args.inputTokens,
        p_output_tokens: args.outputTokens,
        p_cost_usd: args.costUsd,
        p_error: args.error as string,
      });
      if (error) throw new Error(`record_bug_scan_batch: ${error.message}`);
    },
  };

  const result = await runPendingBatches(deps, { batches: plan.batches, completed: scan.completed_batches, failed: scan.failed_batches }, { deadlineAt: Date.now() + budgetMs, signal });
  console.info(JSON.stringify({ event: "bug_scan_step", scanId: scan.id, ...result }));
  return { stopped: result.stopped, processed: result.processed };
}

export async function cancelScan(scanId: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("finish_bug_scan", { p_scan_id: scanId, p_status: "CANCELLED", p_error: "Cancelled." });
  return !error;
}

export async function resumeScan(scanId: string): Promise<{ ok: boolean; error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("resume_bug_scan", { p_scan_id: scanId });
  return error ? { ok: false, error: error.message } : { ok: true };
}
