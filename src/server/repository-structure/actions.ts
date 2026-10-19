"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { getMyRepository } from "@/server/repositories/queries";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE } from "@/server/requirements/errors";
import { getAnalysisReadiness } from "./readiness";
import { analyzeSnapshot } from "./run";
import type { AnalysisActionResult, AnalysisActionState } from "./schema";
import { getSourceProvider } from "./source";

// Every action verifies the session server-side, validates input, then lets the database (RLS, constraints and the
// lifecycle triggers) decide. Ids from the browser are only targets, never proof of authority. The repository is
// resolved from the verified project on the server, the snapshot must belong to it and be COMPLETED, status is
// always PENDING on creation, and the lifecycle and structure are only ever written by the SECURITY DEFINER
// functions the server-side analyzer calls (clients have no UPDATE/INSERT/DELETE on them).

const snapshotIdsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
  snapshotId: idSchema,
});

function revalidateProject(ids: z.infer<typeof snapshotIdsSchema>) {
  revalidatePath(
    `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}`,
  );
}

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

// Creates the analysis (or retries a FAILED one) and runs it with the configured source provider.
// This is the single UI entry point: "Analyze Structure" and "Retry Analysis".
export async function analyzeStructure(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
  // The trailing (prev, formData) pair is the signature useActionState requires; neither is needed here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: AnalysisActionState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<AnalysisActionState> {
  await requireUser();

  const ids = snapshotIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, snapshotId });
  if (!ids.success) return { error: "Invalid snapshot." };

  // Never create or retry an analysis that is certain to fail (no source provider / no persistence key).
  const readiness = getAnalysisReadiness();
  if (!readiness.ready) return { error: readiness.message };

  // The snapshot must belong to this project's own repository and be COMPLETED (so its manifest is sealed).
  const repository = await getMyRepository(ids.data.projectId);
  if (!repository) return { error: PERMISSION_MESSAGE };

  const outcome = await analyzeSnapshot(ids.data.snapshotId, repository.id, getSourceProvider());
  // No revalidatePath: AnalyzeStructureForm reloads the page instead (see src/components/ui/reload.ts).
  // A recorded failure is shown from the analysis itself (status FAILED + message); only an unrecorded one is an action error.
  if (!outcome.ok && !outcome.recorded) return { error: outcome.error };
  return { success: outcome.ok ? "Structure analysis completed." : "The analysis finished with an error; see the analysis status." };
}

// Deleting an analysis removes its symbols and relationships (cascade). It is the explicit, authorized way to
// run a fresh analysis of a snapshot whose analysis is COMPLETED.
export async function deleteAnalysis(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
): Promise<AnalysisActionResult> {
  await requireUser();

  const ids = snapshotIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, snapshotId });
  if (!ids.success) return { error: "Invalid snapshot." };

  const repository = await getMyRepository(ids.data.projectId);
  if (!repository) return { error: PERMISSION_MESSAGE };

  const supabase = await createClient();
  const { data: snapshot } = await supabase
    .from("repository_snapshots")
    .select("id")
    .eq("id", ids.data.snapshotId)
    .eq("repository_id", repository.id)
    .maybeSingle();
  if (!snapshot) return { error: PERMISSION_MESSAGE };

  const { data, error } = await supabase
    .from("repository_structure_analyses")
    .delete()
    .eq("snapshot_id", snapshot.id)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidateProject(ids.data);
  return {};
}
