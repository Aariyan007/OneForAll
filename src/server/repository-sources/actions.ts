"use server";

import { requireUser } from "@/server/auth/session";
import { PERMISSION_MESSAGE } from "@/server/requirements/errors";
import { failStaleSnapshot } from "./ingestion";
import { resolveSnapshotTarget } from "./target";

// Snapshot Server Actions. Source-archive uploads deliberately do NOT use a Server Action: they go to the upload Route
// Handler (…/snapshots/[snapshotId]/source), so file bytes never pass through the Server Action protocol and the Server
// Action body limit stays at the Next.js default.

export type SourceUploadState = { error?: string; success?: string; warning?: string };

// Recovery for a snapshot stuck in PROCESSING (server restart, closed connection, timeout).
export async function markStaleSnapshotFailed(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  snapshotId: string,
  // The (prev, formData) pair is the signature useActionState requires; neither is needed here.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _prev: SourceUploadState,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _formData: FormData,
): Promise<SourceUploadState> {
  await requireUser();
  const target = await resolveSnapshotTarget({ organizationId, departmentId, teamId, projectId, snapshotId });
  if (!target) return { error: PERMISSION_MESSAGE };
  const result = await failStaleSnapshot(target.repositoryId, target.ids.snapshotId);
  if (!result.ok) return { error: result.error };
  // No revalidatePath/redirect(): MarkFailedForm reloads the page (see src/components/ui/reload.ts).
  return { success: "Snapshot marked as failed. Upload its archive again to retry." };
}
