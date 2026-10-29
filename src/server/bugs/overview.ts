import "server-only";
import { OPEN_BUG_STATUSES, REVIEW_BUG_STATUSES, SEVERITY_RANK, type BugSeverity } from "@/lib/bugs/model";
import { bugRef, MY_BUGS_LOAD_ERROR, type MyBugItem, type MyBugsResult, splitMyBugs } from "@/lib/bugs/my-bugs";
import { createClient } from "@/lib/supabase/server";

// Organization-wide and personal bug views, read as the signed-in user: RLS limits every row to the projects they can see.

type ProjectRow = {
  id: string;
  name: string;
  team_id: string;
  teams: { id: string; name: string; department_id: string; departments: { id: string; name: string; organization_id: string } };
};

export type OrgProject = {
  id: string;
  name: string;
  teamName: string;
  path: string;
  repository: { owner: string; name: string } | null;
  snapshot: { id: string; branch: string | null; commit: string; completedAt: string | null } | null;
  openBugs: number;
};

export type OrgBug = {
  id: string;
  title: string;
  severity: BugSeverity;
  status: string;
  category: string;
  filePath: string;
  projectName: string;
  href: string;
  assignedTo: string | null;
  assigneeName: string | null;
  createdAt: string;
};

export async function getOrgBugOverview(organizationId: string, isAdmin: boolean) {
  const supabase = await createClient();
  const { data: projectRows } = await supabase
    .from("projects")
    // `projects_team_id_fkey` names the owning team: since project_teams (collaborating teams) there are two relationships
    // between projects and teams and an unnamed embed fails with "more than one relationship was found".
    .select("id, name, team_id, teams!projects_team_id_fkey!inner(id, name, department_id, departments!inner(id, name, organization_id))")
    .eq("teams.departments.organization_id", organizationId)
    .order("name")
    .limit(200);
  const projects = (projectRows ?? []) as unknown as ProjectRow[];
  const pathOf = (p: ProjectRow) => `/organizations/${organizationId}/departments/${p.teams.departments.id}/teams/${p.teams.id}/projects/${p.id}`;
  const projectIds = projects.map((p) => p.id);

  const { data: repos } = projectIds.length > 0 ? await supabase.from("repositories").select("id, project_id, owner, name").in("project_id", projectIds) : { data: [] };
  const repoByProject = new Map((repos ?? []).map((r) => [r.project_id, r]));
  const repoIds = (repos ?? []).map((r) => r.id);
  const { data: snaps } = repoIds.length > 0 ? await supabase.from("repository_snapshots").select("id, repository_id, branch, commit_sha, completed_at").in("repository_id", repoIds).eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(300) : { data: [] };
  const snapByRepo = new Map<string, NonNullable<typeof snaps>[number]>();
  for (const s of snaps ?? []) if (!snapByRepo.has(s.repository_id)) snapByRepo.set(s.repository_id, s);

  const { data: bugRows } = await supabase
    .from("repository_bugs")
    .select("id, title, severity, status, category, file_path, project_id, assigned_to, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(1000);
  const bugs = bugRows ?? [];
  const openByProject = new Map<string, number>();
  for (const b of bugs) if ((OPEN_BUG_STATUSES as readonly string[]).includes(b.status)) openByProject.set(b.project_id, (openByProject.get(b.project_id) ?? 0) + 1);

  const people = [...new Set(bugs.map((b) => b.assigned_to).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (people.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, display_name, email").in("id", people);
    for (const p of profiles ?? []) names.set(p.id, p.display_name?.trim() || p.email || "Someone");
  }
  const projectById = new Map(projects.map((p) => [p.id, p]));
  const list: OrgBug[] = bugs
    .map((b) => {
      const project = projectById.get(b.project_id);
      return {
        id: b.id,
        title: b.title,
        severity: b.severity as BugSeverity,
        status: b.status,
        category: b.category,
        filePath: b.file_path,
        projectName: project?.name ?? "",
        href: project ? `${pathOf(project)}/bugs/${b.id}` : "#",
        assignedTo: b.assigned_to,
        assigneeName: b.assigned_to ? (names.get(b.assigned_to) ?? "Someone") : null,
        createdAt: b.created_at,
      };
    })
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  const open = list.filter((b) => (OPEN_BUG_STATUSES as readonly string[]).includes(b.status));

  const workload = new Map<string, { name: string; open: number; critical: number }>();
  for (const b of open) {
    if (!b.assignedTo) continue;
    const w = workload.get(b.assignedTo) ?? { name: b.assigneeName ?? "Someone", open: 0, critical: 0 };
    w.open++;
    if (b.severity === "CRITICAL" || b.severity === "HIGH") w.critical++;
    workload.set(b.assignedTo, w);
  }

  let usage: { scans: number; tokens: number; costUsd: number; runs: number } | null = null;
  if (isAdmin) {
    const since = new Date(Date.now() - 30 * 864e5).toISOString();
    const { data: scans } = await supabase.from("repository_bug_scans").select("input_tokens, output_tokens, cost_usd").eq("organization_id", organizationId).gte("created_at", since).limit(500);
    const { data: runs } = await supabase.from("ai_runs").select("input_tokens, output_tokens, estimated_cost_usd").eq("organization_id", organizationId).in("job_type", ["bug_scan", "bug_fix_plan"]).gte("created_at", since).limit(2000);
    usage = {
      scans: scans?.length ?? 0,
      runs: runs?.length ?? 0,
      tokens: (runs ?? []).reduce((n, r) => n + Number(r.input_tokens ?? 0) + Number(r.output_tokens ?? 0), 0),
      costUsd: (runs ?? []).reduce((n, r) => n + Number(r.estimated_cost_usd ?? 0), 0),
    };
  }

  const orgProjects: OrgProject[] = projects.map((p) => {
    const repo = repoByProject.get(p.id);
    const snap = repo ? snapByRepo.get(repo.id) : undefined;
    return {
      id: p.id,
      name: p.name,
      teamName: p.teams.name,
      path: pathOf(p),
      repository: repo ? { owner: repo.owner, name: repo.name } : null,
      snapshot: snap ? { id: snap.id, branch: snap.branch, commit: snap.commit_sha, completedAt: snap.completed_at } : null,
      openBugs: openByProject.get(p.id) ?? 0,
    };
  });

  return {
    projects: orgProjects,
    bugs: list,
    open,
    awaitingApproval: open.filter((b) => b.status === "AWAITING_APPROVAL"),
    unassigned: open.filter((b) => !b.assignedTo),
    bySeverity: Object.fromEntries((["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const).map((s) => [s, open.filter((b) => b.severity === s).length])) as Record<BugSeverity, number>,
    workload: [...workload.entries()].map(([id, w]) => ({ id, ...w })).sort((a, b) => b.open - a.open),
    usage,
  };
}

const MY_BUG_COLUMNS = "id, title, description, severity, status, category, file_path, project_id, organization_id, assigned_to, assigned_at, created_at";
const MY_BUGS_LIMIT = 300;

// The signed-in person's own queue: open bugs assigned to them, and bugs other people fixed that wait for their review or
// verification. Read as the signed-in user (RLS decides what they see). Two queries, so a long review queue can never push an
// assigned bug out of the first N rows. Any failure is returned as `ok: false`: callers must not show it as "nothing assigned".
export async function getMyBugs(userId: string): Promise<MyBugsResult> {
  const supabase = await createClient();
  const [mine, review] = await Promise.all([
    supabase.from("repository_bugs").select(MY_BUG_COLUMNS).eq("assigned_to", userId).in("status", [...OPEN_BUG_STATUSES]).order("assigned_at", { ascending: false, nullsFirst: false }).limit(MY_BUGS_LIMIT),
    supabase.from("repository_bugs").select(MY_BUG_COLUMNS).in("status", [...REVIEW_BUG_STATUSES]).order("created_at", { ascending: false }).limit(MY_BUGS_LIMIT),
  ]);
  if (mine.error || review.error) {
    console.error("[bugs] my bugs query failed", { mine: mine.error?.message, review: review.error?.message });
    return { ok: false, error: MY_BUGS_LOAD_ERROR };
  }
  const bugs = [...mine.data, ...review.data.filter((b) => b.assigned_to !== userId)];

  const projectIds = [...new Set(bugs.map((b) => b.project_id))];
  const { data: projectRows, error: projectError } =
    projectIds.length > 0 ? await supabase.from("projects").select("id, name, teams!projects_team_id_fkey!inner(id, department_id, departments!inner(id, organization_id, organizations!inner(name)))").in("id", projectIds) : { data: [], error: null };
  if (projectError) {
    console.error("[bugs] my bugs projects query failed", projectError.message);
    return { ok: false, error: MY_BUGS_LOAD_ERROR };
  }
  type P = { id: string; name: string; teams: { id: string; departments: { id: string; organization_id: string; organizations: { name: string } } } };
  const byId = new Map(((projectRows ?? []) as unknown as P[]).map((p) => [p.id, p]));

  // The AI's latest fix plan, when there is one. Supplementary: without it the bug is still listed.
  const plans = new Map<string, string>();
  if (mine.data.length > 0) {
    const { data: fixes } = await supabase.from("repository_bug_fixes").select("bug_id, version, plan").in("bug_id", mine.data.map((b) => b.id)).order("version", { ascending: false }).limit(500);
    for (const f of fixes ?? []) {
      const summary = (f.plan as { summary?: unknown } | null)?.summary;
      if (typeof summary === "string" && summary.trim() && !plans.has(f.bug_id)) plans.set(f.bug_id, summary.trim());
    }
  }

  const items: MyBugItem[] = bugs.flatMap((b) => {
    const p = byId.get(b.project_id);
    // A bug whose project chain is not readable cannot be opened; listing it with a dead link would only mislead.
    if (!p) return [];
    return [
      {
        id: b.id,
        ref: bugRef(b.id),
        title: b.title,
        severity: b.severity as BugSeverity,
        status: b.status,
        category: b.category,
        filePath: b.file_path,
        mine: b.assigned_to === userId,
        projectName: p.name,
        organizationName: p.teams.departments.organizations.name,
        href: `/organizations/${p.teams.departments.organization_id}/departments/${p.teams.departments.id}/teams/${p.teams.id}/projects/${p.id}/bugs/${b.id}`,
        assignedAt: b.assigned_at,
        explanation: b.description?.trim() || null,
        fixPlan: plans.get(b.id) ?? null,
      },
    ];
  });
  return { ok: true, ...splitMyBugs(items) };
}
