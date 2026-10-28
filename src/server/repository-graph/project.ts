import "server-only";
import { createClient } from "@/lib/supabase/server";
import { SUPPORTED_LANGUAGES } from "@/server/repository-structure/parser-registry";
import { type GraphAccess, getGraphAccess } from "./queries";

// The whole-project graph of one snapshot: repository -> directories -> files (CONTAINS), file -> file (IMPORTS) from the
// stored import edges, and file -> symbols (DEFINES) from the structure analysis. Everything is read as the signed-in
// user (RLS decides what exists for them); counts are computed from what is actually stored, never estimated.

export type ProjectGraphFile = {
  id: string;
  path: string;
  language: string | null;
  sizeBytes: number;
  symbols: number; // symbols the structure analysis extracted from this file
  parsed: boolean; // the language has a parser and the analysis completed
  hasText: boolean; // source text is stored, so the file can be opened
  bugs: number; // open bugs located in this file
};

export type ProjectGraphData = {
  repository: { owner: string; name: string; url: string };
  snapshot: { id: string; branch: string | null; commit: string; status: string; importedAt: string | null };
  analysis: { status: string | null; symbols: number; relationships: number };
  files: ProjectGraphFile[];
  edges: { source: string; target: string; specifier: string }[]; // file ids
  counts: {
    files: number;
    parsedFiles: number;
    unsupportedFiles: number;
    failedFiles: number;
    directories: number;
    symbols: number;
    importEdges: number;
    nodes: number;
    edges: number;
  };
};

const PAGE = 1000;

export async function loadProjectGraph(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
): Promise<{ access: GraphAccess; data: ProjectGraphData } | null> {
  const access = await getGraphAccess(organizationId, departmentId, teamId, projectId, snapshotId);
  if (!access) return null;
  const supabase = await createClient();
  const analysisDone = access.analysis?.status === "COMPLETED";

  const files: { id: string; path: string; language: string | null; size_bytes: number }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("repository_files")
      .select("id, path, language, size_bytes")
      .eq("snapshot_id", access.snapshot.id)
      .order("path")
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Failed to load the files.");
    files.push(...data);
    if (data.length < PAGE) break;
  }

  const withText = new Set<string>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("repository_file_contents").select("file_id").eq("snapshot_id", access.snapshot.id).order("file_id").range(from, from + PAGE - 1);
    if (error) throw new Error("Failed to load the stored files.");
    for (const row of data) withText.add(row.file_id);
    if (data.length < PAGE) break;
  }

  const symbolsByFile = new Map<string, number>();
  if (analysisDone && access.analysis) {
    const { data, error } = await supabase.rpc("repository_graph_overview", { p_analysis_id: access.analysis.id });
    if (error) throw new Error("Failed to load the structure overview.");
    for (const row of data) symbolsByFile.set(row.file_id, row.symbols);
  }

  const edges: { source: string; target: string; specifier: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("repository_file_edges")
      .select("source_file_id, target_file_id, specifier")
      .eq("snapshot_id", access.snapshot.id)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error("Failed to load the import edges.");
    for (const row of data) edges.push({ source: row.source_file_id, target: row.target_file_id, specifier: row.specifier });
    if (data.length < PAGE) break;
  }

  const supported = new Set<string>(SUPPORTED_LANGUAGES);
  const graphFiles: ProjectGraphFile[] = files.map((f) => ({
    id: f.id,
    path: f.path,
    language: f.language,
    sizeBytes: f.size_bytes,
    symbols: symbolsByFile.get(f.id) ?? 0,
    parsed: analysisDone && f.language !== null && supported.has(f.language),
    hasText: withText.has(f.id),
    bugs: 0,
  }));

  const directories = new Set<string>();
  for (const f of files) {
    const parts = f.path.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  const parsedFiles = graphFiles.filter((f) => f.parsed).length;
  const symbols = access.analysis?.symbols_count ?? 0;
  const relationships = access.analysis?.relationships_count ?? 0;
  const treeNodes = 1 + directories.size + files.length;

  return {
    access,
    data: {
      repository: { owner: access.context.repository.owner, name: access.context.repository.name, url: access.context.repository.repository_url },
      snapshot: { id: access.snapshot.id, branch: access.snapshot.branch, commit: access.snapshot.commit_sha, status: access.snapshot.status, importedAt: access.snapshot.created_at },
      analysis: { status: access.analysis?.status ?? null, symbols, relationships },
      files: graphFiles,
      edges,
      counts: {
        files: files.length,
        parsedFiles,
        unsupportedFiles: files.length - parsedFiles,
        failedFiles: access.analysis?.files_failed ?? 0,
        directories: directories.size,
        symbols,
        importEdges: edges.length,
        nodes: treeNodes + symbols,
        // CONTAINS (one per tree node but the root) + IMPORTS between files + symbol-level relationships of the analysis.
        edges: treeNodes - 1 + edges.length + relationships,
      },
    },
  };
}

export type FileSymbol = { id: string; name: string; kind: string; qualifiedName: string | null; startLine: number; endLine: number; signature: string | null };

// Symbols the structure analysis found in one file (1-based lines), at most 300.
export async function loadFileSymbols(access: GraphAccess, fileId: string): Promise<FileSymbol[] | null> {
  if (access.analysis?.status !== "COMPLETED") return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("repository_graph_symbols", { p_analysis_id: access.analysis.id, p_file_id: fileId, p_limit: 300 });
  if (error) throw new Error("Failed to load the symbols.");
  return data.map((s) => ({
    id: s.id,
    name: s.name,
    kind: s.kind,
    qualifiedName: s.qualified_name || null,
    startLine: s.start_line + 1,
    endLine: s.end_line + 1,
    signature: s.signature || null,
  }));
}

export type SymbolHit = { id: string; name: string; kind: string; fileId: string; path: string; line: number };

export async function searchProjectSymbols(access: GraphAccess, query: string): Promise<SymbolHit[]> {
  if (access.analysis?.status !== "COMPLETED") return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("repository_graph_search", { p_analysis_id: access.analysis.id, p_query: query.slice(0, 200), p_limit: 20 });
  if (error) throw new Error("Failed to search the symbols.");
  return data.map((s) => ({ id: s.id, name: s.name, kind: s.kind, fileId: s.file_id, path: s.path, line: s.start_line + 1 }));
}
