import "server-only";
import { OPEN_BUG_STATUSES, SEVERITY_RANK, type BugSeverity } from "@/lib/bugs/model";
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
    .select("id, name, team_id, teams!inner(id, name, department_id, departments!inner(id, name, organization_id))")
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

// The signed-in person's own queue: bugs assigned to them, and bugs waiting for their review or verification.
export async function getMyBugs(userId: string) {
  const supabase = await createClient();
  const { data: rows } = await supabase
    .from("repository_bugs")
    .select("id, title, severity, status, category, file_path, project_id, organization_id, assigned_to, created_at")
    .or(`assigned_to.eq.${userId},status.in.(CODE_REVIEW,QA_VERIFICATION)`)
    .not("status", "in", "(RESOLVED,REJECTED,CANCELLED)")
    .order("created_at", { ascending: false })
    .limit(300);
  const bugs = rows ?? [];
  const projectIds = [...new Set(bugs.map((b) => b.project_id))];
  const { data: projectRows } = projectIds.length > 0 ? await supabase.from("projects").select("id, name, teams!inner(id, department_id, departments!inner(id, organization_id, organizations!inner(name)))").in("id", projectIds) : { data: [] };
  type P = { id: string; name: string; teams: { id: string; departments: { id: string; organization_id: string; organizations: { name: string } } } };
  const byId = new Map(((projectRows ?? []) as unknown as P[]).map((p) => [p.id, p]));
  const items = bugs.map((b) => {
    const p = byId.get(b.project_id);
    return {
      id: b.id,
      title: b.title,
      severity: b.severity as BugSeverity,
      status: b.status,
      category: b.category,
      filePath: b.file_path,
      mine: b.assigned_to === userId,
      projectName: p?.name ?? "",
      organizationName: p?.teams.departments.organizations.name ?? "",
      href: p ? `/organizations/${p.teams.departments.organization_id}/departments/${p.teams.departments.id}/teams/${p.teams.id}/projects/${p.id}/bugs/${b.id}` : "#",
    };
  });
  const rank = (b: { severity: BugSeverity }) => SEVERITY_RANK[b.severity];
  return {
    assigned: items.filter((b) => b.mine).sort((a, b) => rank(b) - rank(a)),
    toReview: items.filter((b) => !b.mine).sort((a, b) => rank(b) - rank(a)),
  };
}
