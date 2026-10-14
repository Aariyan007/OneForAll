import "server-only";
import { createClient } from "@/lib/supabase/server";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE } from "@/server/requirements/errors";
import { runStructureAnalysis } from "./analyzer";
import { analysisStatusSchema } from "./schema";
import type { SourceProvider } from "./source";

// Creates the analysis of a COMPLETED snapshot (or resets a FAILED one) and runs it with the given source provider.
// INTERNAL and server-only (not a Server Action): callers have already verified the session, the project and that
// the snapshot belongs to `repositoryId`. Used by `analyzeStructure` (configured provider) and by archive ingestion
// (a provider bound to the uploaded archive). The lifecycle and structure are still written only by the SECURITY
// DEFINER functions the analyzer calls, with the signed payload and run token.

export type AnalyzeSnapshotResult = { ok: true } | { ok: false; error: string; recorded: boolean };

function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "23505":
      return "This snapshot already has a structure analysis.";
    default:
      return GENERIC_MESSAGE;
  }
}

export async function analyzeSnapshot(snapshotId: string, repositoryId: string, provider: SourceProvider): Promise<AnalyzeSnapshotResult> {
  const supabase = await createClient();
  const { data: snapshot, error: snapshotError } = await supabase
    .from("repository_snapshots")
    .select("id, status")
    .eq("id", snapshotId)
    .eq("repository_id", repositoryId)
    .maybeSingle();
  if (snapshotError) return { ok: false, error: toErrorMessage(snapshotError), recorded: false };
  if (!snapshot) return { ok: false, error: PERMISSION_MESSAGE, recorded: false };
  if (snapshot.status !== "COMPLETED") return { ok: false, error: "Only a completed snapshot can be analysed.", recorded: false };

  const { data: existing, error: existingError } = await supabase
    .from("repository_structure_analyses")
    .select("id, status")
    .eq("snapshot_id", snapshot.id)
    .maybeSingle();
  if (existingError) return { ok: false, error: toErrorMessage(existingError), recorded: false };

  let analysisId: string;
  if (!existing) {
    const { data, error } = await supabase.rpc("create_structure_analysis", { p_snapshot_id: snapshot.id });
    if (error || !data[0]) return { ok: false, error: error ? toErrorMessage(error) : GENERIC_MESSAGE, recorded: false };
    analysisId = data[0].id;
  } else {
    const status = analysisStatusSchema.safeParse(existing.status);
    if (!status.success) return { ok: false, error: GENERIC_MESSAGE, recorded: false };
    if (status.data === "PROCESSING") return { ok: false, error: "An analysis is already in progress.", recorded: false };
    if (status.data === "COMPLETED") {
      return { ok: false, error: "This snapshot is already analysed. Delete the analysis to run it again.", recorded: false };
    }
    analysisId = existing.id;
    if (status.data === "FAILED") {
      // FAILED -> PENDING inside the database: clears the failure, metrics and the old run token.
      const { data, error } = await supabase.rpc("reset_structure_analysis", { p_analysis_id: analysisId });
      if (error) return { ok: false, error: toErrorMessage(error), recorded: false };
      if (data.length === 0) return { ok: false, error: PERMISSION_MESSAGE, recorded: false };
    }
  }

  const outcome = await runStructureAnalysis(analysisId, provider);
  return outcome.ok ? { ok: true } : { ok: false, error: outcome.error, recorded: outcome.recorded };
}
