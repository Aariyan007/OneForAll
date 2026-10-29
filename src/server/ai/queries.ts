import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getMyRepository } from "@/server/repositories/queries";
import { getProjectContext, listRequirements } from "@/server/requirements/queries";
import type { RunMetrics } from "@/lib/ai/present";
import { aiConfigured, configuredProviders } from "./service";

// Everything the AI Assistant page shows, read as the signed-in user (RLS decides what is visible). Returns null for
// anything not permitted, which the page turns into a 404.

export type AssistantSnapshot = { id: string; commitSha: string; branch: string | null; completedAt: string | null; textFiles: number; analysed: boolean };
export type AssistantRun = {
  id: string;
  jobType: string;
  status: string;
  createdAt: string;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  mine: boolean;
  // Per-run measurements persisted when the run finished (null for runs recorded before they were tracked).
  metrics: RunMetrics | null;
};

const MAX_SNAPSHOTS = 20;
const MAX_RUNS = 15;

export async function getAssistantData(organizationId: string, departmentId: string, teamId: string, projectId: string, selectedSnapshotId?: string) {
  const context = await getProjectContext(organizationId, departmentId, teamId, projectId);
  if (!context) return null;
  const supabase = await createClient();
  const repository = await getMyRepository(context.project.id);

  const { data: settings } = await supabase.from("organization_settings").select("ai_enabled").eq("organization_id", context.organization.id).maybeSingle();
  const base = { ...context, repository, configured: aiConfigured(), providers: configuredProviders(), enabled: settings?.ai_enabled ?? true };
  if (!repository) return { ...base, snapshots: [] as AssistantSnapshot[], selected: null, files: [] as string[], requirements: [], runs: [] as AssistantRun[] };

  const { data: rows } = await supabase
    .from("repository_snapshots")
    .select("id, commit_sha, branch, completed_at, repository_structure_analyses(status)")
    .eq("repository_id", repository.id)
    .eq("status", "COMPLETED")
    .order("completed_at", { ascending: false })
    .limit(MAX_SNAPSHOTS);
  const snapshots: AssistantSnapshot[] = await Promise.all(
    (rows ?? []).map(async (row) => {
      const { count } = await supabase.from("repository_file_contents").select("file_id", { count: "exact", head: true }).eq("snapshot_id", row.id);
      const analyses = row.repository_structure_analyses as unknown as { status: string } | { status: string }[] | null;
      const analysis = Array.isArray(analyses) ? analyses[0] : analyses;
      return { id: row.id, commitSha: row.commit_sha, branch: row.branch, completedAt: row.completed_at, textFiles: count ?? 0, analysed: analysis?.status === "COMPLETED" };
    }),
  );
  const usable = snapshots.filter((s) => s.textFiles > 0);
  const selected = usable.find((s) => s.id === selectedSnapshotId) ?? usable[0] ?? null;

  const files: string[] = [];
  if (selected) {
    for (let from = 0; ; from += 1000) {
      const { data } = await supabase
        .from("repository_file_contents")
        .select("repository_files(path)")
        .eq("snapshot_id", selected.id)
        .range(from, from + 999);
      for (const row of data ?? []) {
        const file = row.repository_files as unknown as { path: string } | null;
        if (file?.path) files.push(file.path);
      }
      if (!data || data.length < 1000) break;
    }
    files.sort();
  }

  const { data: { user } } = await supabase.auth.getUser();
  const { data: runRows } = await supabase
    .from("ai_runs")
    .select(
      "id, job_type, status, created_at, input, output, error_message, model, input_tokens, output_tokens, thinking_tokens, cached_input_tokens, estimated_cost_usd, tool_calls, model_calls, requested_by, provider, usage_reported, cost_known, baseline_tokens_estimate, context_tokens_estimate, fallback_used, attempts, route, techniques",
    )
    .eq("project_id", context.project.id)
    .order("created_at", { ascending: false })
    .limit(MAX_RUNS);
  const runs: AssistantRun[] = (runRows ?? []).map((r) => ({
    id: r.id,
    jobType: r.job_type,
    status: r.status,
    createdAt: r.created_at,
    input: r.input,
    output: r.output,
    errorMessage: r.error_message,
    model: r.model,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    costUsd: Number(r.estimated_cost_usd),
    toolCalls: r.tool_calls,
    modelCalls: r.model_calls,
    mine: r.requested_by === user?.id,
    metrics: r.status === "queued" ? null : toRunMetrics(r),
  }));

  const requirements = (await listRequirements(context.project.id)).map((r) => ({ id: r.id, title: r.title, status: r.status }));
  return { ...base, snapshots, selected, files, requirements, runs };
}

type MetricRow = {
  provider: string | null;
  model: string | null;
  usage_reported: boolean;
  input_tokens: number;
  output_tokens: number;
  thinking_tokens: number;
  cached_input_tokens: number;
  estimated_cost_usd: number | string;
  cost_known: boolean;
  attempts: number;
  fallback_used: boolean;
  baseline_tokens_estimate: number | null;
  context_tokens_estimate: number;
  route: unknown;
  techniques: unknown;
};

// The stored routing trail and technique list are JSON written by the server; anything unexpected reads as "none".
export function toRunMetrics(r: MetricRow): RunMetrics {
  const route = (r.route ?? {}) as { attempts?: { provider?: unknown; model?: unknown; outcome?: unknown; usageReported?: unknown }[] };
  const attemptLog = (Array.isArray(route.attempts) ? route.attempts : []).flatMap((a) =>
    typeof a?.provider === "string" && typeof a.model === "string" && typeof a.outcome === "string" ? [{ provider: a.provider, model: a.model, outcome: a.outcome, usageReported: a.usageReported === true }] : [],
  );
  return {
    provider: r.provider,
    model: r.model,
    usageReported: r.usage_reported,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    thinkingTokens: r.thinking_tokens,
    cachedInputTokens: r.cached_input_tokens,
    costUsd: Number(r.estimated_cost_usd),
    costKnown: r.cost_known,
    attempts: r.attempts,
    fallback: r.fallback_used,
    baselineTokensEstimate: r.baseline_tokens_estimate,
    contextTokensEstimate: r.context_tokens_estimate,
    techniques: Array.isArray(r.techniques) ? r.techniques.filter((t): t is string => typeof t === "string") : [],
    attemptLog,
  };
}
