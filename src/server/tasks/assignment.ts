import "server-only";
import { type Candidate, rankCandidates } from "@/lib/workforce/assignment";
import { createClient } from "@/lib/supabase/server";

// Candidates for a task come from task_assignment_candidates() (OWNER/ADMIN only, eligibility facts computed in the
// database from memberships, project access, workforce profiles and active tasks); the ranking is the pure,
// documented rankCandidates(). Returns null when the caller may not see candidates.
export async function getAssignmentRanking(task: { id: string; estimated_hours: number | null }, options: { automatic?: boolean } = {}) {
  const supabase = await createClient();
  const [{ data, error }, { count, error: countError }] = await Promise.all([
    supabase.rpc("task_assignment_candidates", { p_task_id: task.id }),
    supabase.from("task_required_skills").select("skill_id", { count: "exact", head: true }).eq("task_id", task.id),
  ]);
  if (error || !data || countError) return null;
  const candidates: Candidate[] = data.map((c) => ({
    userId: c.user_id,
    name: c.display_name || c.email,
    availability: c.availability,
    inTaskTeam: c.in_project_team,
    matchedSkills: c.matched_skills,
    requiredSkills: c.required_skills,
    activeTasks: c.active_tasks,
    activeHours: Number(c.active_hours),
    unestimatedTasks: c.unestimated_tasks,
  }));
  const requiredSkills = count ?? 0;
  return { candidates, ranking: rankCandidates(candidates, { estimatedHours: task.estimated_hours == null ? null : Number(task.estimated_hours), requiredSkills }, options) };
}
