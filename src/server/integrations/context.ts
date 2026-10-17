import "server-only";
import { getMyRepository } from "@/server/repositories/queries";
import { getProjectContext } from "@/server/requirements/queries";

// The verified target of every integration request: the organization -> department -> team -> project chain is
// re-checked from the database (RLS applies); ids from the URL are only targets. `canManage` is a hint used to refuse
// early; the database functions decide every write.
export async function getIntegrationContext(organizationId: string, departmentId: string, teamId: string, projectId: string) {
  const context = await getProjectContext(organizationId, departmentId, teamId, projectId);
  if (!context) return null;
  const repository = await getMyRepository(context.project.id);
  return { ...context, repository };
}

export type IntegrationContext = NonNullable<Awaited<ReturnType<typeof getIntegrationContext>>>;

export function integrationsPath(ids: { organizationId: string; departmentId: string; teamId: string; projectId: string }) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/integrations`;
}
