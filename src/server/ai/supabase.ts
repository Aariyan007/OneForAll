import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import type { RunOutcome, RunStore } from "./orchestrator";
import type { FileMeta, RepoReader, RequirementInfo, SymbolHit } from "./tools";
import { isTerminal } from "./state";
import type { RunState } from "./types";

// Database-backed RepoReader and RunStore. Both use the request's Supabase client, which acts as the signed-in user:
// every read is filtered by RLS (a snapshot the user cannot see returns nothing), and run progress goes through the
// SECURITY DEFINER functions of migration 20261028000003, which re-check that the run is the caller's own.

const PAGE = 1000;

type Client = Awaited<ReturnType<typeof createClient>>;

export async function createSnapshotReader(snapshotId: string, projectId: string): Promise<RepoReader> {
  const supabase = await createClient();
  let manifest: Map<string, FileMeta & { id: string }> | null = null;
  let analysisId: string | null | undefined;

  const loadManifest = async () => {
    if (manifest) return manifest;
    const files = new Map<string, FileMeta & { id: string }>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("repository_files")
        .select("id, path, language, size_bytes")
        .eq("snapshot_id", snapshotId)
        .order("path")
        .range(from, from + PAGE - 1);
      if (error) throw new Error("manifest read failed");
      for (const row of data) files.set(row.path, { id: row.id, path: row.path, language: row.language, sizeBytes: row.size_bytes, hasText: false });
      if (data.length < PAGE) break;
    }
    const byId = new Map([...files.values()].map((f) => [f.id, f]));
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from("repository_file_contents")
        .select("file_id")
        .eq("snapshot_id", snapshotId)
        .order("file_id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error("content index read failed");
      for (const row of data) {
        const file = byId.get(row.file_id);
        if (file) file.hasText = true;
      }
      if (data.length < PAGE) break;
    }
    manifest = files;
    return files;
  };

  const loadAnalysisId = async () => {
    if (analysisId !== undefined) return analysisId;
    const { data } = await supabase
      .from("repository_structure_analyses")
      .select("id")
      .eq("snapshot_id", snapshotId)
      .eq("status", "COMPLETED")
      .maybeSingle();
    analysisId = data?.id ?? null;
    return analysisId;
  };

  return {
    async listFiles() {
      return [...(await loadManifest()).values()].map(({ path, language, sizeBytes, hasText }) => ({ path, language, sizeBytes, hasText }));
    },
    async readText(path) {
      const file = (await loadManifest()).get(path);
      if (!file?.hasText) return null;
      const { data, error } = await supabase.from("repository_file_contents").select("content").eq("file_id", file.id).maybeSingle();
      if (error) throw new Error("content read failed");
      return data?.content ?? null;
    },
    async searchCode(query, limit) {
      const { data, error } = await supabase.rpc("repository_code_search", { p_snapshot_id: snapshotId, p_query: query, p_limit: limit });
      if (error) throw new Error("code search failed");
      return data.map((row) => ({ path: row.path, line: row.line_number, text: row.line }));
    },
    async searchSymbols(query, limit): Promise<SymbolHit[]> {
      const id = await loadAnalysisId();
      const q = query.trim();
      if (!id || q.length === 0) return [];
      const { data, error } = await supabase.rpc("repository_graph_search", { p_analysis_id: id, p_query: q.slice(0, 200), p_limit: limit });
      if (error) throw new Error("symbol search failed");
      // Analysis positions are 0-based; the AI layer uses 1-based lines throughout.
      return data.map((row) => ({ name: row.name, kind: row.kind, qualifiedName: row.qualified_name, path: row.path, line: row.start_line + 1, signature: null }));
    },
    async getRequirement(id): Promise<RequirementInfo | null> {
      return loadRequirement(supabase, id, projectId);
    },
  };
}

async function loadRequirement(supabase: Client, id: string, projectId: string): Promise<RequirementInfo | null> {
  const { data: requirement } = await supabase
    .from("requirements")
    .select("id, title, description, status")
    .eq("id", id)
    .eq("project_id", projectId)
    .maybeSingle();
  if (!requirement) return null;
  const { data: tasks } = await supabase
    .from("tasks")
    .select("title, description, status, acceptance_criteria")
    .eq("requirement_id", requirement.id)
    .order("created_at")
    .limit(50);
  return {
    title: requirement.title,
    description: requirement.description,
    status: requirement.status,
    tasks: (tasks ?? []).map((t) => ({ title: t.title, description: t.description, status: t.status, acceptanceCriteria: t.acceptance_criteria })),
  };
}

export type PersistentRunStore = RunStore & { finish(outcome: RunOutcome): Promise<void> };

const CANCEL_CHECK_INTERVAL_MS = 1500;

export async function createRunStore(runId: string): Promise<PersistentRunStore> {
  const supabase = await createClient();
  let lastCheck = 0;
  let cancelled = false;
  return {
    async transition(state: RunState, detail?: Record<string, unknown>) {
      // Terminal states are written once, with the outcome and metrics, by finish().
      if (isTerminal(state)) return;
      const { error } = await supabase.rpc("record_ai_run_state", { p_run_id: runId, p_state: state, p_detail: (detail ?? null) as Json });
      if (error) throw new Error("run state write failed");
    },
    async cancelRequested() {
      if (cancelled) return true;
      const now = Date.now();
      if (now - lastCheck < CANCEL_CHECK_INTERVAL_MS) return false;
      lastCheck = now;
      const { data } = await supabase.from("ai_runs").select("cancel_requested").eq("id", runId).maybeSingle();
      cancelled = data?.cancel_requested === true;
      return cancelled;
    },
    async finish(outcome: RunOutcome) {
      const { error } = await supabase.rpc("finish_ai_run", {
        p_run_id: runId,
        p_status: outcome.status,
        p_output: (outcome.status === "completed" ? (outcome.result ?? {}) : null) as Json,
        // The generated types mark every text argument as non-null; the function accepts NULL for these two.
        p_error_category: (outcome.status === "completed" ? null : (outcome.error?.category ?? outcome.status)) as string,
        p_error_message: (outcome.status === "completed" ? null : (outcome.error?.message ?? null)) as string,
        p_metrics: {
          tier: outcome.tier ?? null,
          model: outcome.model ?? null,
          input_tokens: outcome.usage.inputTokens,
          output_tokens: outcome.usage.outputTokens,
          cached_input_tokens: outcome.usage.cachedInputTokens,
          thinking_tokens: outcome.usage.thinkingTokens,
          estimated_cost_usd: outcome.costUsd,
          model_calls: outcome.turns,
          tool_calls: outcome.toolCalls,
          attempts: outcome.attempts,
          fallback_used: outcome.fallback,
          citations_dropped: outcome.citationsDropped,
          context_tokens_estimate: outcome.contextTokensEstimate,
        },
      });
      if (error) throw new Error("run finish write failed");
    },
  };
}
