import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { can } from "@/lib/authz/permissions";
import { getMyOrganization } from "@/server/organizations/queries";
import { getMyDepartment, getMyTeam } from "@/server/teams/queries";

// Verifies the whole chain from the database, never from the URL:
// organization (caller is a member) -> department (belongs to it) -> team (belongs to it).
// Returns null for malformed ids, other tenants and mismatched paths alike, so callers 404
// without revealing which link failed. `canManage` and `canView` are UI hints; RLS decides.
export async function getTeamContext(organizationId: string, departmentId: string, teamId: string) {
  if (![organizationId, departmentId, teamId].every((id) => idSchema.safeParse(id).success)) return null;

  const user = await requireUser();
  const organization = await getMyOrganization(organizationId, user.id);
  if (!organization) return null;
  const department = await getMyDepartment(organization.id, departmentId);
  if (!department) return null;
  const team = await getMyTeam(department.id, teamId);
  if (!team) return null;

  const canManage = can(organization.role, "hierarchy.manage");
  const supabase = await createClient();
  const { data: membership, error } = await supabase
    .from("team_members")
    .select("id")
    .eq("team_id", team.id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (error) throw new Error(`Failed to load team membership: ${error.message}`);

  return { organization, department, team, canManage, canView: canManage || Boolean(membership) };
}

export async function listProjects(teamId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, slug, description, project_type, status")
    .eq("team_id", teamId)
    .order("name");

  if (error) throw new Error(`Failed to load projects: ${error.message}`);
  return data;
}

// RLS returns the project only to OWNER/ADMIN or members of its team.
export async function getMyProject(teamId: string, projectId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, slug, description, project_type, status, created_at")
    .eq("id", projectId)
    .eq("team_id", teamId)
    .maybeSingle();

  if (error) throw new Error(`Failed to load project: ${error.message}`);
  return data;
}
