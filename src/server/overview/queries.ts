import "server-only";
import { createClient } from "@/lib/supabase/server";
import { ACTIVE_STATUSES } from "@/lib/tasks/workflow";
import { profileNames } from "@/server/tasks/queries";

// Organization overview. Everything is read with the caller's client, so RLS decides what each role sees: owners and
// admins see every project's tasks, employees only the projects of their teams. Nothing here is an authorization
// decision; counts are of visible rows.

export type OverviewTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  assigneeId: string | null;
  href: string;
  projectName: string;
  ids: { organizationId: string; departmentId: string; teamId: string; projectId: string; requirementId: string; taskId: string };
};

type Row = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  assignee_id: string | null;
  requirements: { id: string; projects: { id: string; name: string; team_id: string; teams: { id: string; department_id: string; departments: { organization_id: string } } } };
};

// projects -> teams is named explicitly: project_teams (collaborating teams) is a second path between the two tables.
const SELECT =
  "id, title, status, priority, due_date, assignee_id, requirements!inner(id, projects!inner(id, name, team_id, teams!projects_team_id_fkey!inner(id, department_id, departments!inner(organization_id))))";

function toTask(r: Row): OverviewTask {
  const p = r.requirements.projects;
  const ids = {
    organizationId: p.teams.departments.organization_id,
    departmentId: p.teams.department_id,
    teamId: p.team_id,
    projectId: p.id,
    requirementId: r.requirements.id,
    taskId: r.id,
  };
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    priority: r.priority,
    dueDate: r.due_date,
    assigneeId: r.assignee_id,
    projectName: p.name,
    href: `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/requirements/${ids.requirementId}/tasks/${ids.taskId}`,
    ids,
  };
}

// Open (active) tasks of the organization that the caller can see, newest activity first.
export async function listOpenOrganizationTasks(organizationId: string, limit = 1000): Promise<OverviewTask[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select(SELECT)
    .eq("requirements.projects.teams.departments.organization_id", organizationId)
    .in("status", [...ACTIVE_STATUSES])
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Failed to load the organization's tasks.");
  return (data as unknown as Row[]).map(toTask);
}

export async function getStructureCounts(organizationId: string) {
  const supabase = await createClient();
  const [departments, teams, projects, members] = await Promise.all([
    supabase.from("departments").select("id", { count: "exact", head: true }).eq("organization_id", organizationId),
    supabase.from("teams").select("id, departments!inner(organization_id)", { count: "exact", head: true }).eq("departments.organization_id", organizationId),
    supabase
      .from("projects")
      .select("id, teams!projects_team_id_fkey!inner(departments!inner(organization_id))", { count: "exact", head: true })
      .eq("teams.departments.organization_id", organizationId),
    supabase.from("organization_members").select("id", { count: "exact", head: true }).eq("organization_id", organizationId).eq("status", "ACTIVE"),
  ]);
  return { departments: departments.count ?? 0, teams: teams.count ?? 0, projects: projects.count ?? 0, members: members.count ?? 0 };
}

// Pending handoffs into teams of this organization (owners/admins see all; others those of their tasks/teams).
export async function listPendingHandoffs(organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("task_handoffs")
    .select(`id, to_team_id, summary, created_at, teams!task_handoffs_to_team_id_fkey(name), tasks!inner(${SELECT})`)
    .eq("status", "PENDING")
    .eq("tasks.requirements.projects.teams.departments.organization_id", organizationId)
    .order("created_at")
    .limit(50);
  if (error) return [];
  return (data as unknown as { id: string; summary: string; created_at: string; teams: { name: string } | null; tasks: Row }[]).map((h) => ({
    id: h.id,
    team: h.teams?.name ?? "A team",
    summary: h.summary,
    createdAt: h.created_at,
    task: toTask(h.tasks),
  }));
}

// Workload per member (owners/admins; organization_workload() refuses others), with names, heaviest first.
export async function getWorkloadSummary(organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("organization_workload", { p_organization_id: organizationId });
  if (error || !data) return [];
  const names = await profileNames(data.map((w) => w.user_id));
  return data
    .map((w) => ({ ...w, name: names.get(w.user_id) ?? "Member" }))
    .sort((a, b) => Number(b.active_hours) - Number(a.active_hours) || b.active_tasks - a.active_tasks);
}

export { profileNames };
