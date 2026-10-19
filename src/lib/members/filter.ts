// Members list search and role filter (Members page, ?q= and ?role=). Pure: no "@/" imports, tested under plain Node.
// Filtering only narrows rows the caller is already allowed to see (the list comes from RLS-filtered queries); it is
// never an authorization decision.

export const MEMBER_ROLE_FILTERS = ["OWNER", "ADMIN", "MEMBER"] as const;
export type MemberRoleFilter = (typeof MEMBER_ROLE_FILTERS)[number];

export const MEMBER_STATUS_FILTERS = ["ACTIVE", "SUSPENDED"] as const;
export type MemberStatusFilter = (typeof MEMBER_STATUS_FILTERS)[number];

export type MemberFilter = { q: string; role: MemberRoleFilter | null; status?: MemberStatusFilter | null };

type Filterable = {
  role: string;
  status?: string;
  name: string;
  email: string;
  jobTitle: string | null;
  department: string | null;
  team: string | null;
};

const MAX_QUERY = 100;

// Reads the URL parameters. Unknown roles, arrays and over-long text are ignored rather than rejected, so a hand-edited
// URL simply shows the unfiltered list.
export function parseMemberFilter(params: { q?: string | string[]; role?: string | string[]; status?: string | string[] }): MemberFilter {
  const q = typeof params.q === "string" ? params.q.trim().slice(0, MAX_QUERY) : "";
  const role = typeof params.role === "string" && (MEMBER_ROLE_FILTERS as readonly string[]).includes(params.role)
    ? (params.role as MemberRoleFilter)
    : null;
  const status = typeof params.status === "string" && (MEMBER_STATUS_FILTERS as readonly string[]).includes(params.status)
    ? (params.status as MemberStatusFilter)
    : null;
  return { q, role, status };
}

// Case-insensitive match of every whitespace-separated term against name, email, job title, department and team.
export function filterMembers<T extends Filterable>(members: readonly T[], filter: MemberFilter): T[] {
  const terms = filter.q.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return members.filter((m) => {
    if (filter.role && m.role !== filter.role) return false;
    if (filter.status && (m.status ?? "ACTIVE") !== filter.status) return false;
    if (terms.length === 0) return true;
    const haystack = [m.name, m.email, m.jobTitle, m.department, m.team].filter(Boolean).join(" ").toLocaleLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

export function isFiltered(filter: MemberFilter): boolean {
  return filter.q.length > 0 || filter.role !== null || Boolean(filter.status);
}
