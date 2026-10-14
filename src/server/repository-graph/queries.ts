import "server-only";
import { createClient } from "@/lib/supabase/server";
import { buildRepositoryGraph, type RelationshipRow, type SymbolRow } from "@/lib/repository-graph/transform";
import type { RepositoryGraph } from "@/lib/repository-graph/types";
import { idSchema } from "@/server/departments/schema";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";
import { getAnalysisForSnapshot } from "@/server/repository-structure/queries";

// Read-only repository graph of ONE snapshot's structure analysis. Every step reads through the signed-in user's
// Supabase client, so RLS applies throughout; the chain is verified from the database, never from the URL:
//   organization -> department -> team -> project -> repository (getRepositoryContext)
//   -> snapshot of THAT repository -> its analysis -> COMPLETED -> symbols + relationships of THAT analysis.
// No new database functions, no service role, no writes.

// Larger analyses are not sent to the browser in this version (see docs/repository-graph.md). The page states this
// explicitly with the real counts instead of showing a partial graph as if it were complete.
export const GRAPH_MAX_SYMBOLS = 5000;
export const GRAPH_MAX_RELATIONSHIPS = 15000;
const PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request

type Analysis = NonNullable<Awaited<ReturnType<typeof getAnalysisForSnapshot>>>;

export type SnapshotGraphState =
  | { state: "no-analysis" }
  | { state: "not-completed"; analysis: Analysis }
  | { state: "too-large"; analysis: Analysis }
  | { state: "ready"; analysis: Analysis; graph: RepositoryGraph; complete: boolean };

async function loadSymbols(analysisId: string): Promise<SymbolRow[]> {
  const supabase = await createClient();
  const rows: SymbolRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("repository_symbols")
      .select(
        "id, analysis_id, file_id, name, kind, qualified_name, signature, start_line, start_column, end_line, visibility, file:repository_files(path)",
      )
      .eq("analysis_id", analysisId)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("Failed to load repository symbols.");
    for (const { file, ...row } of data) rows.push({ ...row, file_path: file?.path ?? null });
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function loadRelationships(analysisId: string): Promise<RelationshipRow[]> {
  const supabase = await createClient();
  const rows: RelationshipRow[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("repository_symbol_relationships")
      .select("id, analysis_id, source_symbol_id, target_symbol_id, relationship_type")
      .eq("analysis_id", analysisId)
      .order("id")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("Failed to load repository relationships.");
    rows.push(...data);
    if (data.length < PAGE_SIZE) return rows;
  }
}

// Null for malformed ids, other tenants, mismatched paths, projects the caller cannot see, repository-less projects
// and snapshots of another repository alike, so the page 404s without revealing which link failed.
export async function getSnapshotGraph(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
) {
  if (!idSchema.safeParse(snapshotId).success) return null;
  const context = await getRepositoryContext(organizationId, departmentId, teamId, projectId);
  if (!context) return null;

  const supabase = await createClient();
  const { data: snapshot, error } = await supabase
    .from("repository_snapshots")
    .select("id, commit_sha, branch, status, created_at")
    .eq("id", snapshotId)
    .eq("repository_id", context.repository.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load the snapshot.");
  if (!snapshot) return null;

  const analysis = await getAnalysisForSnapshot(snapshot.id);
  let result: SnapshotGraphState;
  if (!analysis) result = { state: "no-analysis" };
  else if (analysis.status !== "COMPLETED") result = { state: "not-completed", analysis };
  else if (analysis.symbols_count > GRAPH_MAX_SYMBOLS || analysis.relationships_count > GRAPH_MAX_RELATIONSHIPS) {
    result = { state: "too-large", analysis };
  } else {
    const [symbols, relationships] = await Promise.all([loadSymbols(analysis.id), loadRelationships(analysis.id)]);
    const graph = buildRepositoryGraph({
      analysisId: analysis.id,
      snapshotId: snapshot.id,
      commitSha: snapshot.commit_sha,
      branch: snapshot.branch,
      symbols,
      relationships,
    });
    // The analysis row records how many symbols/relationships were persisted; anything else is reported, not hidden.
    const complete =
      graph.nodes.length === analysis.symbols_count &&
      graph.edges.length === analysis.relationships_count &&
      graph.diagnostics.rejectedNodes === 0 &&
      graph.diagnostics.rejectedEdges === 0;
    result = { state: "ready", analysis, graph, complete };
  }

  return { ...context, snapshot, ...result };
}
