// Navigation is derived from the current URL only (no data fetching, no new routes). Every enabled link points at
// a route that already exists; destinations that do not exist yet are returned disabled.

export type NavItem = {
  key: string;
  label: string;
  href?: string; // undefined = disabled
  icon: string;
  hint?: string; // shown for disabled items
  soon?: boolean;
  match?: "exact" | "prefix";
};

export type NavSection = { title: string; items: NavItem[] };

export type RouteContext = {
  organizationId?: string;
  departmentId?: string;
  teamId?: string;
  projectId?: string;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseRoute(pathname: string): RouteContext {
  const parts = pathname.split("/").filter(Boolean);
  const ctx: RouteContext = {};
  const take = (key: string) => {
    const index = parts.indexOf(key);
    const value = index >= 0 ? parts[index + 1] : undefined;
    return value && UUID.test(value) ? value : undefined;
  };
  ctx.organizationId = take("organizations");
  if (ctx.organizationId) ctx.departmentId = take("departments");
  if (ctx.departmentId) ctx.teamId = take("teams");
  if (ctx.teamId) ctx.projectId = take("projects");
  return ctx;
}

export function paths(ctx: RouteContext) {
  const org = ctx.organizationId ? `/organizations/${ctx.organizationId}` : undefined;
  const dept = org && ctx.departmentId ? `${org}/departments/${ctx.departmentId}` : undefined;
  const team = dept && ctx.teamId ? `${dept}/teams/${ctx.teamId}` : undefined;
  const project = team && ctx.projectId ? `${team}/projects/${ctx.projectId}` : undefined;
  return {
    orgOverview: org ? `${org}/overview` : undefined,
    settings: org ? `${org}/settings` : undefined,
    members: org ? `${org}/members` : undefined,
    workforce: org ? `${org}/workforce` : undefined,
    departments: org ? `${org}/departments` : undefined,
    teams: dept ? `${dept}/teams` : undefined,
    projects: team ? `${team}/projects` : undefined,
    project,
    requirements: project ? `${project}/requirements` : undefined,
  };
}

// `role` is the caller's role in the current organization, for display only: every destination checks access itself.
export function buildNav(ctx: RouteContext, role?: string): NavSection[] {
  const p = paths(ctx);
  const manager = role === "OWNER" || role === "ADMIN";
  return [
    {
      title: "General",
      items: [
        { key: "dashboard", label: "Dashboard", href: "/dashboard", icon: "dashboard", match: "exact" },
        { key: "my-work", label: "My work", href: "/my-work", icon: "task", match: "exact" },
        { key: "notifications", label: "Notifications", href: "/notifications", icon: "bell", match: "exact" },
        { key: "organizations", label: "Organizations", href: "/organizations/new", icon: "building", match: "exact" },
      ],
    },
    {
      title: "Workspace",
      items: [
        { key: "org-overview", label: "Overview", href: p.orgOverview, icon: "building", hint: "Open an organization", match: "exact" },
        { key: "members", label: "Members", href: p.members, icon: "users", hint: "Open an organization", match: "exact" },
        { key: "workforce", label: "Workforce", href: p.workforce, icon: "sparkle", hint: "Open an organization", match: "prefix" },
        { key: "departments", label: "Departments", href: p.departments, icon: "layers", hint: "Open an organization", match: "exact" },
        { key: "teams", label: "Teams", href: p.teams, icon: "users", hint: "Open a department", match: "exact" },
        { key: "projects", label: "Projects", href: p.projects, icon: "folder", hint: "Open a team", match: "exact" },
        ...(ctx.organizationId && !manager ? [] : [{ key: "settings", label: "Settings", href: p.settings, icon: "settings", hint: "Open an organization", match: "exact" as const }]),
      ],
    },
    {
      title: "Engineering",
      items: [
        { key: "overview", label: "Project overview", href: p.project, icon: "box", hint: "Open a project", match: "exact" },
        { key: "requirements", label: "Requirements", href: p.requirements, icon: "listChecks", hint: "Open a project", match: "prefix" },
        { key: "repository", label: "Repository", href: p.project ? `${p.project}#repository` : undefined, icon: "branch", hint: "Open a project" },
        { key: "intelligence", label: "Engineering Intelligence", href: p.project ? `${p.project}#intelligence` : undefined, icon: "network", hint: "Open a project" },
      ],
    },
  ];
}

export function isActive(item: NavItem, pathname: string): boolean {
  if (!item.href || item.href.includes("#")) return false;
  return item.match === "prefix" ? pathname === item.href || pathname.startsWith(`${item.href}/`) : pathname === item.href;
}
