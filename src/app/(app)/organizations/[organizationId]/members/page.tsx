import Link from "next/link";
import { notFound } from "next/navigation";
import { InviteMemberForm, MemberRoleControl, RemoveMemberButton, RevokeInvitationButton, SuspendMemberButton } from "@/components/members/member-controls";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, EmptyState, formatDate, formatDateTime } from "@/components/ui/data";
import { IconActivity, IconBuilding, IconSearch, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { StatusBadge } from "@/components/ui/status";
import { buttonClass } from "@/components/ui/button";
import { ROLE_LABELS, canChangeRole, canRemoveMember, canSuspendMember, invitableRoles, isOrgRole } from "@/lib/authz/permissions";
import { MEMBER_ROLE_FILTERS, filterMembers, isFiltered, parseMemberFilter } from "@/lib/members/filter";
import { getOrgAccess } from "@/server/authz/access";
import { closeExpiredInvitations, listAuditEvents, listInvitations, listMembers } from "@/server/members/queries";

export const metadata = { title: "Members · OneForAll" };

const AUDIT_LABELS: Record<string, string> = {
  "member.invited": "invited",
  "member.invitation_revoked": "revoked the invitation for",
  "member.joined": "joined",
  "member.role_changed": "changed the role of",
  "member.removed": "removed",
  "member.left": "left",
  "member.suspended": "suspended",
  "member.reactivated": "reactivated",
  "member.invitation_expired": "saw the invitation expire for",
  "structure.imported": "imported departments or teams",
  "workforce.imported": "imported the workforce directory",
  "workforce.profile_updated": "updated the directory entry of",
  "workforce.skill_created": "added a skill",
  "settings.assignment_mode": "changed the assignment policy",
  "project.team_added": "added a collaborating team to a project",
  "project.team_removed": "removed a collaborating team from a project",
};

const SEARCH_CONTROL =
  "h-9 rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

export default async function MembersPage({ params, searchParams }: PageProps<"/organizations/[organizationId]/members">) {
  const { organizationId } = await params;
  // ?q= and ?role= only narrow the list this user may already see (a plain GET form; works without JavaScript).
  const filter = parseMemberFilter(await searchParams);
  const access = await getOrgAccess(organizationId);
  if (!access) notFound();
  const { organization, role, user } = access;
  const canManage = access.can("members.invite");
  // No scheduler: expired invitations are closed (and their inviters notified) when a manager opens this page.
  if (canManage) await closeExpiredInvitations(organization.id);

  const [members, invitations, audit] = await Promise.all([
    listMembers(organization.id),
    canManage ? listInvitations(organization.id) : Promise.resolve([]),
    access.can("audit.view") ? listAuditEvents(organization.id, 30) : Promise.resolve([]),
  ]);
  const nameOf = new Map(members.map((m) => [m.userId, m.name]));
  const actor = { userId: user.id, role };
  const shown = filterMembers(members, filter);
  const filtered = isFiltered(filter);
  const membersHref = `/organizations/${organization.id}/members`;
  const pending = invitations.filter((i) => i.status === "PENDING");
  const closed = invitations.filter((i) => i.status !== "PENDING").slice(0, 20);

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: organization.name, href: `/organizations/${organization.id}/departments` }, { label: "Members" }]}
        icon={<IconUsers size={18} />}
        title="Members"
        description={canManage ? "People in this organization, their roles and pending invitations." : "People in this organization."}
        badges={<StatusBadge kind="role" value={role} label={`You: ${ROLE_LABELS[role]}`} />}
      />

      <div className="flex flex-col gap-8">
        {canManage && (
          <section aria-labelledby="invite-heading">
            <Card>
              <CardHeader
                title={<span id="invite-heading">Invite someone</span>}
                description={
                  role === "OWNER"
                    ? "Owners can invite admins and employees. Nobody can be invited as an owner."
                    : "Admins can invite employees. Ask an owner to add another admin."
                }
              />
              <div className="px-5 py-4">
                <InviteMemberForm organizationId={organization.id} roles={invitableRoles(role)} />
              </div>
            </Card>
          </section>
        )}

        <section>
          <SectionHeader
            title={filtered ? `People (${shown.length} of ${members.length})` : `People (${members.length})`}
            description="Roles apply to this organization only."
          />
          <form method="get" action={membersHref} role="search" aria-label="Filter members" className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="relative flex-1">
              <span className="sr-only">Search members</span>
              <IconSearch size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-fg-3" />
              <input
                type="search"
                name="q"
                defaultValue={filter.q}
                maxLength={100}
                placeholder="Search name, email, job title, department or team"
                className={`${SEARCH_CONTROL} w-full pl-8`}
              />
            </label>
            <label className="flex items-center gap-2">
              <span className="sr-only">Role</span>
              <select name="role" defaultValue={filter.role ?? ""} className={`${SEARCH_CONTROL} cursor-pointer`}>
                <option value="">All roles</option>
                {MEMBER_ROLE_FILTERS.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2">
              <span className="sr-only">Status</span>
              <select name="status" defaultValue={filter.status ?? ""} className={`${SEARCH_CONTROL} cursor-pointer`}>
                <option value="">Any status</option>
                <option value="ACTIVE">Active</option>
                <option value="SUSPENDED">Suspended</option>
              </select>
            </label>
            <div className="flex items-center gap-2">
              <button type="submit" className={buttonClass("secondary", "sm")}>
                Filter
              </button>
              {filtered && (
                <Link href={membersHref} className="text-[12.5px] text-fg-3 underline-offset-2 hover:text-fg hover:underline">
                  Clear
                </Link>
              )}
            </div>
          </form>
          {shown.length === 0 ? (
            <EmptyState compact icon={<IconUsers size={20} />} title="No matching members" description="Try another search term or role." />
          ) : (
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border">
                {shown.map((m) => {
                  const target = { userId: m.userId, role: isOrgRole(m.role) ? m.role : "MEMBER" as const };
                  const self = m.userId === user.id;
                  const roleEditable = isOrgRole(m.role) && (canChangeRole(actor, target, "ADMIN") || canChangeRole(actor, target, "MEMBER"));
                  return (
                    <li key={m.id} className="flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-center gap-3">
                        <Avatar name={m.name} />
                        <div className="min-w-0">
                          <p className="truncate text-[13.5px] font-medium text-fg">
                            {m.name} {self && <span className="text-fg-3">(you)</span>}
                          </p>
                          <p className="truncate text-[12.5px] text-fg-3">
                            {m.email}
                            {(m.jobTitle || m.team) && <> · {[m.jobTitle, [m.department, m.team].filter(Boolean).join(" / ")].filter(Boolean).join(" · ")}</>}
                          </p>
                          <p className="text-[12px] text-fg-3">
                          Joined {formatDate(m.joinedAt)}
                          {m.status === "SUSPENDED" && m.suspendedAt && <> · suspended {formatDate(m.suspendedAt)}</>}
                        </p>
                        </div>
                      </div>
                      <div className="flex flex-wrap items-start gap-2 sm:justify-end">
                      {m.status === "SUSPENDED" && <StatusBadge kind="membership" value="SUSPENDED" />}
                        {roleEditable ? (
                          <MemberRoleControl organizationId={organization.id} memberId={m.id} name={m.name} role={target.role} />
                        ) : (
                          <StatusBadge kind="role" value={m.role} />
                        )}
                        {isOrgRole(m.role) && canSuspendMember(actor, target) && (
                        <SuspendMemberButton organizationId={organization.id} memberId={m.id} name={m.name} suspended={m.status === "SUSPENDED"} />
                      )}
                      {isOrgRole(m.role) && canRemoveMember(actor, target) && (
                          <RemoveMemberButton organizationId={organization.id} memberId={m.id} name={m.name} self={self} />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </section>

        {canManage && (
          <section>
            <SectionHeader title={`Pending invitations (${pending.length})`} description="Each link works once, for the invited email address, for 7 days." />
            {pending.length === 0 ? (
              <EmptyState compact icon={<IconBuilding size={20} />} title="No pending invitations" description="Invitations you create appear here until they are accepted, revoked or expire." />
            ) : (
              <Card className="overflow-hidden">
                <ul className="divide-y divide-border">
                  {pending.map((i) => (
                    <li key={i.id} className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                      <div className="min-w-0">
                        <p className="truncate text-[13.5px] text-fg">{i.email}</p>
                        <p className="text-[12px] text-fg-3">
                          {isOrgRole(i.role) ? ROLE_LABELS[i.role] : i.role} · created {formatDateTime(i.created_at)} · expires {formatDateTime(i.expires_at)}
                        </p>
                      </div>
                      {(role === "OWNER" || i.role === "MEMBER") && <RevokeInvitationButton organizationId={organization.id} invitationId={i.id} email={i.email} />}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {closed.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[12.5px] text-fg-3 hover:text-fg">Recent closed invitations ({closed.length})</summary>
                <ul className="mt-2 flex flex-col gap-1">
                  {closed.map((i) => (
                    <li key={i.id} className="flex items-center gap-2 text-[12.5px] text-fg-2">
                      <StatusBadge kind="invitation" value={i.status} /> {i.email}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>
        )}

        {access.can("audit.view") && (
          <section>
            <SectionHeader title="Membership activity" icon={<IconActivity size={16} />} description="Recent changes to members, the directory and settings." />
            {audit.length === 0 ? (
              <p className="t-small text-fg-3">No activity recorded yet.</p>
            ) : (
              <Card>
                <ol className="divide-y divide-border">
                  {audit.map((e) => (
                    <li key={e.id} className="flex flex-col gap-0.5 px-5 py-2.5 text-[12.5px] sm:flex-row sm:items-center sm:justify-between">
                      <span className="text-fg-2">
                        <span className="text-fg">{(e.actor_id && nameOf.get(e.actor_id)) || "Someone"}</span> {AUDIT_LABELS[e.action] ?? e.action}{" "}
                        {(e.target_user_id && nameOf.get(e.target_user_id)) || e.target_email || ""}
                        {e.action === "member.role_changed" && typeof e.details === "object" && e.details && "to" in e.details && (
                          <> to {isOrgRole(String(e.details.to)) ? ROLE_LABELS[String(e.details.to) as keyof typeof ROLE_LABELS] : String(e.details.to)}</>
                        )}
                      </span>
                      <span className="shrink-0 text-fg-3">{formatDateTime(e.created_at)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            )}
          </section>
        )}
      </div>
    </PageBody>
  );
}
