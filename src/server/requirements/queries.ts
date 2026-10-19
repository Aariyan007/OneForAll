import "server-only";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "@/server/departments/schema";
import { getMyProject, getTeamContext } from "@/server/projects/queries";

// Verifies the whole chain from the database, never from the URL:
// organization -> department -> team -> project. Returns null for malformed ids, other tenants,
// mismatched paths and projects the caller cannot see alike, so callers 404 without revealing
// which link failed. `canManage` is a UI hint; RLS decides.
export async function getProjectContext(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
) {
  if (!idSchema.safeParse(projectId).success) return null;

  const context = await getTeamContext(organizationId, departmentId, teamId);
  if (!context) return null;

  // Scoped to the team and RLS-filtered: a project from another team or tenant is simply not found. RLS alone decides
  // visibility (OWNER/ADMIN, members of the project's team, and since migration 20261024000001 members of a
  // collaborating team), so no separate team-membership pre-check here.
  const project = await getMyProject(context.team.id, projectId);
  if (!project) return null;

  return { ...context, project };
}

export async function listRequirements(projectId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("requirements")
    .select("id, title, status, priority")
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to load requirements: ${error.message}`);
  return data;
}

// Scoped to the project; RLS returns it only when the project itself is visible to the caller.
export async function getMyRequirement(projectId: string, requirementId: string) {
  if (!idSchema.safeParse(requirementId).success) return null;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("requirements")
    .select("id, title, description, status, priority")
    .eq("id", requirementId)
    .eq("project_id", projectId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load requirement: ${error.message}`);
  return data;
}
