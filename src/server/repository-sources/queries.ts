import "server-only";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "@/server/departments/schema";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";
import { SUPPORTED_LANGUAGES } from "@/server/repository-structure/parser-registry";
import { getAnalysisForSnapshot } from "@/server/repository-structure/queries";

// One snapshot with its source record, manifest counts and analysis. Every read uses the signed-in user's client
// (RLS applies) and the chain is verified from the database: org -> department -> team -> project -> repository ->
// snapshot of THAT repository. Null for anything the caller may not see, so the page 404s without an existence leak.
export async function getSnapshotDetail(
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
    .select("id, commit_sha, branch, status, started_at, completed_at, error_message, created_at")
    .eq("id", snapshotId)
    .eq("repository_id", context.repository.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load the snapshot.");
  if (!snapshot) return null;

  const [source, files, supported, analysis] = await Promise.all([
    supabase
      .from("repository_snapshot_sources")
      .select("source_kind, verification, archive_format, archive_sha256, archive_bytes, archive_commit, entries_total, files_accepted, files_skipped, files_skipped_oversized, files_skipped_generated, files_skipped_metadata, files_skipped_sensitive, created_at")
      .eq("snapshot_id", snapshot.id)
      .maybeSingle(),
    supabase.from("repository_files").select("id", { count: "exact", head: true }).eq("snapshot_id", snapshot.id),
    supabase
      .from("repository_files")
      .select("id", { count: "exact", head: true })
      .eq("snapshot_id", snapshot.id)
      .in("language", [...SUPPORTED_LANGUAGES]),
    getAnalysisForSnapshot(snapshot.id),
  ]);
  if (source.error || files.error || supported.error) throw new Error("Failed to load the snapshot source.");

  return {
    ...context,
    snapshot,
    source: source.data,
    manifestFiles: files.count ?? 0,
    supportedFiles: supported.count ?? 0,
    analysis,
  };
}
