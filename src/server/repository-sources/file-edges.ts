import "server-only";
import { createClient } from "@/lib/supabase/server";
import { buildFileEdges } from "@/lib/project-graph/build";

// File-to-file import edges of one COMPLETED snapshot, derived from its stored source text and written through
// store_file_edges (replaces the snapshot's edges; OWNER/ADMIN only, enforced by the database).

export type EdgeSummary = { stored: number; unresolvedLocal: number; filesScanned: number };

export async function storeFileEdges(snapshotId: string, files: readonly { path: string; content: string }[]): Promise<EdgeSummary | null> {
  const built = buildFileEdges(files);
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("store_file_edges", { p_snapshot_id: snapshotId, p_edges: built.edges });
  if (error || typeof data !== "number") return null;
  return { stored: data, unresolvedLocal: built.unresolvedLocal, filesScanned: built.filesScanned };
}

const PAGE = 100;

// For snapshots imported before edges existed: reads the stored text back (as the caller, so RLS applies) and rebuilds.
export async function rebuildFileEdges(snapshotId: string): Promise<EdgeSummary | null> {
  const supabase = await createClient();
  const paths = new Map<string, string>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("repository_files").select("id, path").eq("snapshot_id", snapshotId).order("path").range(from, from + 999);
    if (error) return null;
    for (const row of data) paths.set(row.id, row.path);
    if (data.length < 1000) break;
  }
  const files: { path: string; content: string }[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("repository_file_contents")
      .select("file_id, content")
      .eq("snapshot_id", snapshotId)
      .order("file_id")
      .range(from, from + PAGE - 1);
    if (error) return null;
    for (const row of data) {
      const path = paths.get(row.file_id);
      if (path) files.push({ path, content: row.content });
    }
    if (data.length < PAGE) break;
  }
  return storeFileEdges(snapshotId, files);
}
