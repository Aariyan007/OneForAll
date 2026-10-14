import "server-only";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { idSchema } from "@/server/departments/schema";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";

// Shared by the upload Route Handler and the snapshot Server Actions. Ids from the URL are only targets: the whole
// organization -> department -> team -> project -> repository chain is re-verified from the database (RLS applies),
// and `canManage` is only used to refuse early; the database decides every write.

const idsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
  snapshotId: idSchema,
});

export type SnapshotIds = z.infer<typeof idsSchema>;

export async function resolveSnapshotTarget(raw: Record<keyof SnapshotIds, string>) {
  const ids = idsSchema.safeParse(raw);
  if (!ids.success) return null;
  const context = await getRepositoryContext(ids.data.organizationId, ids.data.departmentId, ids.data.teamId, ids.data.projectId);
  if (!context || !context.canManage) return null;
  return { ids: ids.data, repositoryId: context.repository.id };
}

export function snapshotPath(ids: SnapshotIds) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/repository/snapshots/${ids.snapshotId}`;
}

export function revalidateSnapshotPages(ids: SnapshotIds) {
  const project = `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}`;
  revalidatePath(project);
  revalidatePath(`${project}/repository/snapshots`);
  revalidatePath(snapshotPath(ids));
  revalidatePath(`${snapshotPath(ids)}/graph`);
}
