// Central permission matrix for organization roles. Pure (no I/O), so it is unit-tested and usable from server code
// and, for display only, from client components. It MIRRORS the database rules: RLS policies and the SECURITY DEFINER
// functions (has_org_role(), change_member_role(), assign_task(), ...) remain the authority. A `true` here never
// grants anything by itself; it only decides what the UI offers and lets server code refuse early.
//
// Roles are per organization (organization_members.role). "Employee" in the UI is the MEMBER role.

export const ORG_ROLES = ["OWNER", "ADMIN", "MEMBER"] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export function isOrgRole(value: unknown): value is OrgRole {
  return typeof value === "string" && (ORG_ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<OrgRole, string> = { OWNER: "Owner", ADMIN: "Admin", MEMBER: "Employee" };

const ALL: readonly OrgRole[] = ORG_ROLES;
const MANAGERS: readonly OrgRole[] = ["OWNER", "ADMIN"];
const OWNER_ONLY: readonly OrgRole[] = ["OWNER"];

// Capability -> roles that hold it. Scope notes:
//   * ADMIN is organization-wide: the schema has no per-department admin scope yet.
//   * "Own" capabilities (own task progress, own availability) are further limited to the caller's own records by
//     the database functions.
const MATRIX = {
  "org.read": ALL,
  "org.rename": MANAGERS, // existing RLS: organizations_update_admin
  "org.assignmentPolicy.edit": OWNER_ONLY,
  "hierarchy.manage": MANAGERS, // departments, teams, projects, their memberships
  "members.view": ALL,
  "members.invite": MANAGERS, // which roles: invitableRoles()
  "members.changeRole": OWNER_ONLY,
  "members.remove": MANAGERS, // which targets: canRemoveMember()
  "members.suspend": MANAGERS, // which targets: canSuspendMember()
  "org.settings.view": MANAGERS,
  "audit.view": MANAGERS,
  "workforce.view": MANAGERS,
  "workforce.manage": MANAGERS,
  "workforce.import": MANAGERS,
  "structure.import": MANAGERS, // departments and teams from CSV
  "workforce.editOwn": ALL, // own availability and skills
  "tasks.create": MANAGERS,
  "tasks.assign": MANAGERS,
  "tasks.review": MANAGERS,
  "tasks.updateOwn": ALL, // only tasks assigned to the caller
  "tasks.comment": ALL, // only tasks the caller can see
  "integrations.manage": MANAGERS, // existing behaviour (project_integrations functions)
  "reports.view": MANAGERS,
} as const satisfies Record<string, readonly OrgRole[]>;

export type Capability = keyof typeof MATRIX;
export const CAPABILITIES = Object.keys(MATRIX) as Capability[];

// Accepts the raw text of organization_members.role: anything that is not a known role holds no capability.
export function can(role: string | null | undefined, capability: Capability): boolean {
  return isOrgRole(role) && (MATRIX[capability] as readonly OrgRole[]).includes(role);
}

// Roles an actor may put on an invitation. Nobody can invite an OWNER.
export function invitableRoles(role: OrgRole | null | undefined): OrgRole[] {
  if (role === "OWNER") return ["ADMIN", "MEMBER"];
  if (role === "ADMIN") return ["MEMBER"];
  return [];
}

type Member = { userId: string; role: OrgRole };

// Role changes: OWNER only, never on an OWNER membership, never on oneself, never to OWNER (ownership transfer is a
// separate, not yet supported operation). Mirrors change_member_role().
export function canChangeRole(actor: Member, target: Member, next: OrgRole): boolean {
  return (
    actor.role === "OWNER" &&
    actor.userId !== target.userId &&
    target.role !== "OWNER" &&
    next !== "OWNER" &&
    next !== target.role
  );
}

// Removal: an OWNER may remove ADMINs and MEMBERs, an ADMIN may remove MEMBERs; an OWNER membership is never removed;
// any non-owner may leave. Mirrors remove_organization_member().
export function canRemoveMember(actor: Member, target: Member): boolean {
  if (target.role === "OWNER") return false;
  if (actor.userId === target.userId) return true;
  if (actor.role === "OWNER") return true;
  return actor.role === "ADMIN" && target.role === "MEMBER";
}

// Suspension: an OWNER suspends or reactivates ADMINs and MEMBERs, an ADMIN only MEMBERs; never an OWNER, never
// oneself. Mirrors suspend_organization_member() / reactivate_organization_member().
export function canSuspendMember(actor: Member, target: Member): boolean {
  if (target.role === "OWNER" || actor.userId === target.userId) return false;
  if (actor.role === "OWNER") return true;
  return actor.role === "ADMIN" && target.role === "MEMBER";
}
