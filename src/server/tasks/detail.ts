import "server-only";
import { createClient } from "@/lib/supabase/server";
import { getMyRequirement, getProjectContext } from "@/server/requirements/queries";
import { idSchema } from "@/server/departments/schema";
import { profileNames } from "./queries";

// The organization -> department -> team -> project -> requirement -> task chain, verified from the database (RLS
// applies at every step). Returns null for malformed ids, other tenants and mismatched paths alike.
export async function getTaskContext(ids: { organizationId: string; departmentId: string; teamId: string; projectId: string; requirementId: string; taskId: string }) {
  if (!idSchema.safeParse(ids.taskId).success || !idSchema.safeParse(ids.requirementId).success) return null;
  const project = await getProjectContext(ids.organizationId, ids.departmentId, ids.teamId, ids.projectId);
  if (!project) return null;
  const requirement = await getMyRequirement(project.project.id, ids.requirementId);
  if (!requirement) return null;
  const supabase = await createClient();
  const { data: task, error } = await supabase
    .from("tasks")
    .select("id, title, description, status, priority, assignee_id, assigned_by, assigned_at, team_id, acceptance_criteria, estimated_hours, due_date, qa_required, created_by, created_at, updated_at")
    .eq("id", ids.taskId)
    .eq("requirement_id", requirement.id)
    .maybeSingle();
  if (error) throw new Error("Failed to load the task.");
  if (!task) return null;
  return { ...project, requirement, task };
}

export type TaskContext = NonNullable<Awaited<ReturnType<typeof getTaskContext>>>;

// Everything the task page shows, read with the caller's client (RLS: what the caller may see).
export async function getTaskDetail(context: TaskContext) {
  const supabase = await createClient();
  const taskId = context.task.id;
  const [skills, deps, dependents, comments, events, handoffs, projectTasks, projectTeams, defects, links, mentionable] = await Promise.all([
    supabase.from("task_required_skills").select("skill_id, skills(id, name)").eq("task_id", taskId),
    supabase.from("task_dependencies").select("depends_on_task_id").eq("task_id", taskId),
    supabase.from("task_dependencies").select("task_id").eq("depends_on_task_id", taskId),
    supabase.from("task_comments").select("id, author_id, body, created_at").eq("task_id", taskId).order("created_at").limit(200),
    supabase.from("task_events").select("id, actor_id, event_type, from_status, to_status, details, created_at").eq("task_id", taskId).order("id", { ascending: false }).limit(100),
    supabase.from("task_handoffs").select("id, from_team_id, to_team_id, summary, remaining_work, notes, status, created_by, created_at, responded_by, responded_at, response_note").eq("task_id", taskId).order("created_at", { ascending: false }),
    supabase
      .from("tasks")
      .select("id, title, status, requirement_id, requirements!inner(project_id)")
      .eq("requirements.project_id", context.project.id)
      .order("created_at")
      .limit(500),
    supabase.from("project_teams").select("team_id").eq("project_id", context.project.id),
    supabase
      .from("task_defects")
      .select("id, title, details, severity, status, reported_by, reported_at, resolved_by, resolved_at, resolution")
      .eq("task_id", taskId)
      .order("reported_at", { ascending: false })
      .limit(200),
    supabase.from("task_links").select("id, url, label, created_by, created_at").eq("task_id", taskId).order("created_at"),
    supabase.rpc("task_mention_candidates", { p_task_id: taskId }),
  ]);
  for (const r of [skills, deps, dependents, comments, events, handoffs, projectTasks, projectTeams, defects, links, mentionable]) {
    if (r.error) throw new Error("Failed to load the task details.");
  }
  const taskById = new Map(projectTasks.data!.map((t) => [t.id, t]));
  const teamIds = [context.team.id, ...projectTeams.data!.map((t) => t.team_id)];
  const { data: teams } = await supabase.from("teams").select("id, name").in("id", [...new Set([...teamIds, ...handoffs.data!.flatMap((h) => [h.from_team_id, h.to_team_id].filter((x): x is string => Boolean(x)))])]);
  const teamName = new Map((teams ?? []).map((t) => [t.id, t.name]));
  const names = await profileNames([
    context.task.assignee_id,
    context.task.assigned_by,
    context.task.created_by,
    ...comments.data!.map((c) => c.author_id),
    ...events.data!.map((e) => e.actor_id),
    ...handoffs.data!.flatMap((h) => [h.created_by, h.responded_by]),
    ...defects.data!.flatMap((d) => [d.reported_by, d.resolved_by]),
  ]);
  const toTask = (id: string) => {
    const t = taskById.get(id);
    return t ? { id: t.id, title: t.title, status: t.status, requirementId: t.requirement_id } : { id, title: "Task", status: "UNKNOWN", requirementId: null };
  };
  return {
    requiredSkills: skills.data!.flatMap((s) => (s.skills ? [s.skills] : [])),
    dependencies: deps.data!.map((d) => toTask(d.depends_on_task_id)),
    dependents: dependents.data!.map((d) => toTask(d.task_id)),
    comments: comments.data!,
    events: events.data!,
    handoffs: handoffs.data!,
    projectTasks: projectTasks.data!.filter((t) => t.id !== taskId).map((t) => ({ id: t.id, title: t.title, status: t.status })),
    projectTeams: teamIds.map((id) => ({ id, name: teamName.get(id) ?? "Team", own: id === context.team.id })),
    defects: defects.data!,
    links: links.data!,
    mentionable: mentionable.data!.map((m) => ({ id: m.user_id, name: m.display_name ?? "Member" })),
    teamName,
    names,
  };
}
