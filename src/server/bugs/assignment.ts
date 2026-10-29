import "server-only";
import { type BugFacts, type Candidate, planAutoAssignment, rankCandidates, type Ranked } from "@/lib/bugs/assign";
import { REASSIGNABLE_BUG_STATUSES } from "@/lib/bugs/model";
import { createClient } from "@/lib/supabase/server";

// Assignment as the signed-in admin. The database decides who is eligible (list_bug_assignment_candidates) and re-checks
// the chosen person on assign_bug; this module only ranks and calls those functions.

export async function listCandidates(projectId: string): Promise<Candidate[] | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_bug_assignment_candidates", { p_project_id: projectId });
  if (error) return null;
  return data.map((row) => ({
    userId: row.user_id,
    name: row.display_name,
    role: row.role,
    jobTitle: row.job_title,
    availability: row.availability,
    onProjectTeam: row.on_project_team,
    skills: row.skills,
    openBugs: row.open_bugs,
    openTasks: row.open_tasks,
  }));
}

export type Recommendation = { userId: string; name: string; role: string; score: number; reasons: string[]; openBugs: number; availability: string };

export function toRecommendations(ranked: Ranked[]): Recommendation[] {
  return ranked.map((r) => ({ userId: r.candidate.userId, name: r.candidate.name, role: r.candidate.role, score: Math.round(r.score * 10) / 10, reasons: r.reasons, openBugs: r.candidate.openBugs, availability: r.candidate.availability }));
}

// For the manual picker: every eligible person (owners and admins included), best first, each with the reasons.
export async function recommendFor(projectId: string, bug: BugFacts): Promise<Recommendation[] | null> {
  const candidates = await listCandidates(projectId);
  if (!candidates) return null;
  // Rank everyone for display; a manual choice is not restricted to employees.
  const asEmployees = candidates.map((c) => ({ ...c, role: "MEMBER" }));
  const ranked = rankCandidates(asEmployees, bug);
  const roleById = new Map(candidates.map((c) => [c.userId, c.role]));
  return toRecommendations(ranked).map((r) => ({ ...r, role: roleById.get(r.userId) ?? r.role }));
}

export async function assign(bugId: string, userId: string, source: "MANUAL" | "AUTO", reason: string): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_bug", { p_bug_id: bugId, p_assignee: userId, p_source: source, p_reason: reason });
  if (!error) return { ok: true };
  if (error.code === "42501") return { ok: false, status: 403, error: "Only organization owners and admins can assign bugs." };
  if (error.code === "22023") return { ok: false, status: 422, error: "That person cannot take this bug (not an active member who can see the project, or unavailable)." };
  if (error.code === "55000") return { ok: false, status: 409, error: error.message };
  return { ok: false, status: 500, error: "The bug could not be assigned." };
}

export async function unassign(bugId: string, reason: string) {
  const supabase = await createClient();
  const { error } = await supabase.rpc("unassign_bug", { p_bug_id: bugId, p_reason: reason });
  if (!error) return { ok: true as const };
  return { ok: false as const, status: error.code === "42501" ? 403 : error.code === "55000" ? 409 : 500, error: error.code === "55000" ? error.message : "The bug could not be unassigned." };
}

export type AutoAssignSummary = { assigned: { bugId: string; title: string; userId: string; name: string; reason: string }[]; left: { bugId: string; title: string; reason: string }[] };

// Assigns the given bugs, or every unassigned open bug of the project when none are named, to the best eligible people,
// spreading the load. Named bugs may already be assigned (that is a reassignment). A named bug that cannot be assigned is
// reported in `left` instead of being dropped, so the caller never sees "success" for a bug that did not move.
export async function autoAssign(projectId: string, bugIds?: string[]): Promise<AutoAssignSummary | null> {
  const candidates = await listCandidates(projectId);
  if (!candidates) return null;
  const supabase = await createClient();
  const named = bugIds && bugIds.length > 0 ? bugIds : null;
  let query = supabase.from("repository_bugs").select("id, title, category, severity, file_path, assigned_to").eq("project_id", projectId);
  query = named ? query.in("id", named).in("status", [...REASSIGNABLE_BUG_STATUSES]) : query.is("assigned_to", null).in("status", ["DETECTED", "TRIAGED", "REOPENED"]);
  const { data: bugs, error } = await query.limit(100);
  if (error) return null;
  const titles = new Map(bugs.map((b) => [b.id, b.title]));
  const plan = planAutoAssignment(bugs.map((b) => ({ id: b.id, category: b.category, severity: b.severity, filePath: b.file_path, assignedTo: b.assigned_to })), candidates);
  const names = new Map(candidates.map((c) => [c.userId, c.name]));
  const summary: AutoAssignSummary = { assigned: [], left: [] };
  for (const id of named ?? []) {
    if (!titles.has(id)) summary.left.push({ bugId: id, title: "", reason: "That bug was not found in this project or is in a stage that cannot be assigned." });
  }
  for (const item of plan) {
    if (!item.userId) {
      summary.left.push({ bugId: item.bugId, title: titles.get(item.bugId) ?? "", reason: item.reason });
      continue;
    }
    const result = await assign(item.bugId, item.userId, "AUTO", item.reason);
    if (result.ok) summary.assigned.push({ bugId: item.bugId, title: titles.get(item.bugId) ?? "", userId: item.userId, name: names.get(item.userId) ?? "", reason: item.reason });
    else summary.left.push({ bugId: item.bugId, title: titles.get(item.bugId) ?? "", reason: result.error });
  }
  return summary;
}
