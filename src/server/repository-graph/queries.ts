import "server-only";
import { createClient } from "@/lib/supabase/server";
import {
  COMPLETE_GRAPH_MAX_RELATIONSHIPS,
  COMPLETE_GRAPH_MAX_SYMBOLS,
  FILE_EDGE_LIMIT,
  FILE_SYMBOL_LIMIT,
  NEIGHBOUR_EDGE_LIMIT,
  SEARCH_LIMIT,
  SEARCH_MAX_QUERY,
  decideGraphMode,
} from "@/lib/repository-graph/explore";
import { buildRepositoryGraph, type RelationshipRow, type SymbolRow } from "@/lib/repository-graph/transform";
import type { GraphOverview, GraphPiece, GraphSearchResult, RepositoryGraph } from "@/lib/repository-graph/types";
import { idSchema } from "@/server/departments/schema";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";
import { getAnalysisForSnapshot } from "@/server/repository-structure/queries";

// Read-only repository graph of ONE snapshot's structure analysis. Every step reads through the signed-in user's
// Supabase client, so RLS applies throughout; the chain is verified from the database, never from the URL:
//   organization -> department -> team -> project -> repository (getRepositoryContext)
//   -> snapshot of THAT repository -> its analysis -> COMPLETED -> symbols + relationships of THAT analysis.
// No service role, no writes. Large analyses are never loaded whole: they are explored through bounded, SECURITY
// INVOKER database functions (migration 20261020000001), one piece at a time.

// Analyses up to these sizes are sent whole and drawn as the complete graph (see docs/repository-graph.md).
export const GRAPH_MAX_SYMBOLS = COMPLETE_GRAPH_MAX_SYMBOLS;
export const GRAPH_MAX_RELATIONSHIPS = COMPLETE_GRAPH_MAX_RELATIONSHIPS;
const PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request
const ID_BATCH = 1000; // the read functions accept at most 1000 ids per call

type Analysis = NonNullable<Awaited<ReturnType<typeof getAnalysisForSnapshot>>>;
type Context = NonNullable<Awaited<ReturnType<typeof getRepositoryContext>>>;
type Snapshot = { id: string; commit_sha: string; branch: string; status: string; created_at: string };

export type SnapshotGraphState =
  | { state: "no-analysis" }
  | { state: "not-completed"; analysis: Analysis }
  | { state: "ready"; analysis: Analysis; graph: RepositoryGraph; complete: boolean }
  | { state: "explore"; analysis: Analysis; overview: GraphOverview };

// The authorized target of every graph read. Null for malformed ids, other tenants, mismatched paths, projects the
// caller cannot see, repository-less projects and snapshots of another repository alike.
export type GraphAccess = { context: Context; snapshot: Snapshot; analysis: Analysis | null };

export async function getGraphAccess(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
): Promise<GraphAccess | null> {
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

  return { context, snapshot, analysis: await getAnalysisForSnapshot(snapshot.id) };
}

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
    for (const row of data) rows.push(row); // no argument spread: page sizes are bounded, but stay explicit
    if (data.length < PAGE_SIZE) return rows;
  }
}

async function loadOverview(analysisId: string): Promise<GraphOverview> {
  const supabase = await createClient();
  const [files, summary] = await Promise.all([
    supabase.rpc("repository_graph_overview", { p_analysis_id: analysisId }),
    supabase.rpc("repository_graph_summary", { p_analysis_id: analysisId }),
  ]);
  if (files.error || summary.error) throw new Error("Failed to load the graph overview.");
  const nodesByKind: Record<string, number> = {};
  const edgesByType: Record<string, number> = {};
  for (const row of summary.data) {
    if (row.category === "kind") nodesByKind[row.name] = row.total;
    else if (row.category === "relationship") edgesByType[row.name] = row.total;
  }
  return {
    files: files.data.map((row) => ({
      fileId: row.file_id,
      path: row.path,
      symbols: row.symbols,
      relationships: row.relationships,
      externalRelationships: row.external_relationships,
    })),
    nodesByKind,
    edgesByType,
  };
}

export async function getSnapshotGraph(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
) {
  const access = await getGraphAccess(organizationId, departmentId, teamId, projectId, snapshotId);
  if (!access) return null;
  const { context, snapshot, analysis } = access;

  let result: SnapshotGraphState;
  if (!analysis) result = { state: "no-analysis" };
  else if (analysis.status !== "COMPLETED") result = { state: "not-completed", analysis };
  else if (decideGraphMode(analysis.symbols_count, analysis.relationships_count) === "explore") {
    // Too large to send whole: only the per-file overview (bounded by the manifest) is loaded here.
    result = { state: "explore", analysis, overview: await loadOverview(analysis.id) };
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

// ---------------------------------------------------------------------------------------------------------------
// Bounded pieces for exploring a COMPLETED analysis (used by the graph data Route Handler).

export type CompletedGraphAccess = GraphAccess & { analysis: Analysis };

export function completedAccess(access: GraphAccess | null): CompletedGraphAccess | null {
  return access?.analysis?.status === "COMPLETED" ? (access as CompletedGraphAccess) : null;
}

type SymbolFnRow = SymbolRow & { path: string };

function toSymbolRow(row: Omit<SymbolFnRow, "file_path">): SymbolRow {
  return { ...row, file_path: row.path };
}

async function symbolsByIds(analysisId: string, ids: readonly string[]): Promise<SymbolRow[]> {
  const supabase = await createClient();
  const rows: SymbolRow[] = [];
  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);
    const { data, error } = await supabase.rpc("repository_graph_symbols", { p_analysis_id: analysisId, p_ids: batch, p_limit: batch.length });
    if (error) throw new Error("Failed to load repository symbols.");
    for (const row of data) rows.push(toSymbolRow(row));
  }
  return rows;
}

async function edgesTouching(analysisId: string, ids: readonly string[], limit: number) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("repository_graph_edges", { p_analysis_id: analysisId, p_symbol_ids: [...ids], p_limit: limit });
  if (error) throw new Error("Failed to load repository relationships.");
  const total = data.length > 0 ? Number(data[0].total_relationships) : 0;
  const rows: RelationshipRow[] = data.map(({ id, analysis_id, source_symbol_id, target_symbol_id, relationship_type }) => ({
    id,
    analysis_id,
    source_symbol_id,
    target_symbol_id,
    relationship_type,
  }));
  return { rows, total };
}

function assemble(access: CompletedGraphAccess, symbols: SymbolRow[], relationships: RelationshipRow[]) {
  return buildRepositoryGraph({
    analysisId: access.analysis.id,
    snapshotId: access.snapshot.id,
    commitSha: access.snapshot.commit_sha,
    branch: access.snapshot.branch,
    symbols,
    relationships,
  });
}

// All symbols of one file of this snapshot (up to FILE_SYMBOL_LIMIT), every relationship touching them (up to
// FILE_EDGE_LIMIT), and the symbols at the other end of those relationships. Null when the file is not part of this
// snapshot's manifest (or not visible).
export async function loadFilePiece(access: CompletedGraphAccess, fileId: string): Promise<GraphPiece | null> {
  if (!idSchema.safeParse(fileId).success) return null;
  const supabase = await createClient();
  const { data: file, error } = await supabase
    .from("repository_files")
    .select("id, path")
    .eq("id", fileId)
    .eq("snapshot_id", access.snapshot.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load the file.");
  if (!file) return null;

  const [symbolsResult, countResult] = await Promise.all([
    supabase.rpc("repository_graph_symbols", { p_analysis_id: access.analysis.id, p_file_id: file.id, p_limit: FILE_SYMBOL_LIMIT }),
    supabase.from("repository_symbols").select("id", { count: "exact", head: true }).eq("analysis_id", access.analysis.id).eq("file_id", file.id),
  ]);
  if (symbolsResult.error || countResult.error) throw new Error("Failed to load repository symbols.");
  const fileSymbols = symbolsResult.data.map(toSymbolRow);
  const fileIds = fileSymbols.map((row) => row.id);

  const edges = fileIds.length > 0 ? await edgesTouching(access.analysis.id, fileIds, FILE_EDGE_LIMIT) : { rows: [], total: 0 };
  const inFile = new Set(fileIds);
  const outside = new Set<string>();
  for (const edge of edges.rows) {
    if (!inFile.has(edge.source_symbol_id)) outside.add(edge.source_symbol_id);
    if (!inFile.has(edge.target_symbol_id)) outside.add(edge.target_symbol_id);
  }
  const external = outside.size > 0 ? await symbolsByIds(access.analysis.id, [...outside]) : [];

  const graph = assemble(access, [...fileSymbols, ...external], edges.rows);
  return {
    scope: { type: "file", fileId: file.id, filePath: file.path },
    nodes: graph.nodes,
    edges: graph.edges,
    symbolsTotal: countResult.count ?? fileSymbols.length,
    symbolsReturned: fileSymbols.length,
    edgesTotal: edges.total,
    edgesReturned: edges.rows.length,
    rejected: { nodes: graph.diagnostics.rejectedNodes, edges: graph.diagnostics.rejectedEdges },
  };
}

// One symbol, every relationship touching it (up to NEIGHBOUR_EDGE_LIMIT) and the symbols at their other ends. Null
// when the symbol is not part of this analysis (or not visible).
export async function loadNeighbourPiece(access: CompletedGraphAccess, symbolId: string): Promise<GraphPiece | null> {
  if (!idSchema.safeParse(symbolId).success) return null;
  const [self] = await symbolsByIds(access.analysis.id, [symbolId]);
  if (!self) return null;

  const edges = await edgesTouching(access.analysis.id, [symbolId], NEIGHBOUR_EDGE_LIMIT);
  const others = new Set<string>();
  for (const edge of edges.rows) {
    if (edge.source_symbol_id !== symbolId) others.add(edge.source_symbol_id);
    if (edge.target_symbol_id !== symbolId) others.add(edge.target_symbol_id);
  }
  const neighbours = others.size > 0 ? await symbolsByIds(access.analysis.id, [...others]) : [];

  const graph = assemble(access, [self, ...neighbours], edges.rows);
  return {
    scope: { type: "neighbours", symbolId },
    nodes: graph.nodes,
    edges: graph.edges,
    symbolsTotal: 1,
    symbolsReturned: 1,
    edgesTotal: edges.total,
    edgesReturned: edges.rows.length,
    rejected: { nodes: graph.diagnostics.rejectedNodes, edges: graph.diagnostics.rejectedEdges },
  };
}

// Plain-text search over the analysis (at most SEARCH_LIMIT results, plus the total number of matches).
export async function searchSymbols(access: CompletedGraphAccess, query: string): Promise<{ results: GraphSearchResult[]; total: number }> {
  const q = query.trim();
  if (q.length === 0 || q.length > SEARCH_MAX_QUERY) return { results: [], total: 0 };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("repository_graph_search", { p_analysis_id: access.analysis.id, p_query: q, p_limit: SEARCH_LIMIT });
  if (error) throw new Error("Failed to search repository symbols.");
  return {
    total: data.length > 0 ? Number(data[0].total_matches) : 0,
    results: data.map((row) => ({
      id: row.id,
      label: row.name,
      kind: row.kind,
      qualifiedName: row.qualified_name,
      fileId: row.file_id,
      filePath: row.path,
      startLine: row.start_line + 1,
    })),
  };
}
