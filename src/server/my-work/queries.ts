import "server-only";
import { createClient } from "@/lib/supabase/server";

// The signed-in person's work across organizations. Everything is read with their own client: tasks are visible only
// through project visibility (RLS), handoffs to their teams through task_handoffs RLS.

type Path = { organizationId: string; organizationName: string; departmentId: string; teamId: string; projectId: string; projectName: string; requirementId: string; requirementTitle: string };

export type MyTask = {
  id: string;
  title: string;
  status: string;
  priority: string;
  dueDate: string | null;
  estimatedHours: number | null;
  href: string;
  path: Path;
  openDependencies: number;
};

// projects -> teams is named explicitly: project_teams (collaborating teams) is a second path between the two tables.
const TASK_SELECT =
  "id, title, status, priority, due_date, estimated_hours, team_id, assignee_id, requirements!inner(id, title, projects!inner(id, name, team_id, teams!projects_team_id_fkey!inner(id, department_id, departments!inner(id, organization_id, organizations!inner(id, name)))))";

type Row = {
  id: string;
  title: string;
  status: string;
  priority: string;
  due_date: string | null;
  estimated_hours: number | null;
  team_id: string | null;
  assignee_id: string | null;
  requirements: {
    id: string;
    title: string;
    projects: { id: string; name: string; team_id: string; teams: { id: string; department_id: string; departments: { id: string; organization_id: string; organizations: { id: string; name: string } } } };
  };
};

function toTask(row: Row): MyTask {
  const r = row.requirements;
  const p = r.projects;
  const path: Path = {
    organizationId: p.teams.departments.organization_id,
    organizationName: p.teams.departments.organizations.name,
    departmentId: p.teams.department_id,
    teamId: p.team_id,
    projectId: p.id,
    projectName: p.name,
    requirementId: r.id,
    requirementTitle: r.title,
  };
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    dueDate: row.due_date,
    estimatedHours: row.estimated_hours,
    href: `/organizations/${path.organizationId}/departments/${path.departmentId}/teams/${path.teamId}/projects/${path.projectId}/requirements/${path.requirementId}/tasks/${row.id}`,
    path,
    openDependencies: 0,
  };
}

// Unfinished dependencies per task (visible rows only), so "up next" can separate ready work from waiting work.
async function withOpenDependencies(tasks: MyTask[]): Promise<MyTask[]> {
  const ids = tasks.filter((t) => t.status === "TODO" || t.status === "BLOCKED").map((t) => t.id);
  if (ids.length === 0) return tasks;
  const supabase = await createClient();
  const { data } = await supabase.from("task_dependencies").select("task_id, tasks!task_dependencies_depends_on_task_id_fkey(status)").in("task_id", ids);
  const open = new Map<string, number>();
  for (const d of (data ?? []) as unknown as { task_id: string; tasks: { status: string } | null }[]) {
    if (d.tasks && d.tasks.status !== "COMPLETED" && d.tasks.status !== "CANCELLED") open.set(d.task_id, (open.get(d.task_id) ?? 0) + 1);
  }
  return tasks.map((t) => ({ ...t, openDependencies: open.get(t.id) ?? 0 }));
}

export async function listMyTasks(userId: string): Promise<MyTask[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").select(TASK_SELECT).eq("assignee_id", userId).order("updated_at", { ascending: false }).limit(300);
  if (error) throw new Error("Failed to load your tasks.");
  return withOpenDependencies((data as unknown as Row[]).map(toTask));
}

// Tasks in QA that the person may test: the responsible team (task team, else project team) is one of theirs and
// they are not the assignee. Mirrors private.can_test_task(); the database still decides.
export async function listMyQaQueue(userId: string): Promise<MyTask[]> {
  const supabase = await createClient();
  const { data: teams } = await supabase.from("team_members").select("team_id").eq("user_id", userId);
  const mine = new Set((teams ?? []).map((t) => t.team_id));
  if (mine.size === 0) return [];
  const { data, error } = await supabase.from("tasks").select(TASK_SELECT).eq("status", "IN_QA").order("updated_at", { ascending: false }).limit(200);
  if (error) throw new Error("Failed to load the QA queue.");
  return (data as unknown as Row[])
    .filter((r) => r.assignee_id !== userId && mine.has(r.team_id ?? r.requirements.projects.team_id))
    .map(toTask);
}

// Tasks waiting for review in the organizations the person manages (owners and admins review).
export async function listMyReviewQueue(managedOrganizationIds: string[]): Promise<MyTask[]> {
  if (managedOrganizationIds.length === 0) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.from("tasks").select(TASK_SELECT).eq("status", "IN_REVIEW").order("updated_at", { ascending: true }).limit(200);
  if (error) throw new Error("Failed to load the review queue.");
  const managed = new Set(managedOrganizationIds);
  return (data as unknown as Row[]).map(toTask).filter((t) => managed.has(t.path.organizationId));
}

export async function listHandoffsToMyTeams(userId: string) {
  const supabase = await createClient();
  const { data: teams } = await supabase.from("team_members").select("team_id, teams(name)").eq("user_id", userId);
  const teamIds = (teams ?? []).map((t) => t.team_id);
  if (teamIds.length === 0) return [];
  const { data, error } = await supabase
    .from("task_handoffs")
    .select(`id, to_team_id, summary, created_at, tasks!inner(${TASK_SELECT})`)
    .eq("status", "PENDING")
    .in("to_team_id", teamIds)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) throw new Error("Failed to load handoffs.");
  const teamName = new Map((teams ?? []).map((t) => [t.team_id, t.teams?.name ?? "Your team"]));
  return (data as unknown as { id: string; to_team_id: string; summary: string; created_at: string; tasks: Row }[]).map((h) => ({
    id: h.id,
    team: teamName.get(h.to_team_id) ?? "Your team",
    summary: h.summary,
    createdAt: h.created_at,
    task: toTask(h.tasks),
  }));
}
