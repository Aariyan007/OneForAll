import Link from "next/link";
import { notFound } from "next/navigation";
import { AssignQueueButton } from "@/components/organizations/org-controls";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, MetricCard, formatDateTime } from "@/components/ui/data";
import { IconActivity, IconBuilding, IconLayers, IconSettings, IconTask, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { PriorityBadge, StatusBadge } from "@/components/ui/status";
import { ROLE_LABELS } from "@/lib/authz/permissions";
import { TASK_STATUS_LABELS, isTaskStatus } from "@/lib/tasks/workflow";
import { getOrgAccess } from "@/server/authz/access";
import { closeExpiredInvitations, listAuditEvents } from "@/server/members/queries";
import { type OverviewTask, getStructureCounts, getWorkloadSummary, listOpenOrganizationTasks, listPendingHandoffs, profileNames } from "@/server/overview/queries";
import { getAssignmentMode } from "@/server/workforce/queries";

export const metadata = { title: "Overview · OneForAll" };

const MODE_TEXT: Record<string, string> = {
  MANUAL: "Manual: owners and admins choose the assignee.",
  RECOMMEND: "Recommendation first: the best-ranked person is preselected for confirmation.",
  AUTO: "Automatic: tasks with required skills can be assigned to the best eligible person.",
};

function TaskRows({ tasks, names, empty }: { tasks: OverviewTask[]; names: Map<string, string>; empty: string }) {
  if (tasks.length === 0) return <p className="t-small px-5 py-4 text-fg-3">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {tasks.map((t) => (
        <li key={t.id}>
          <Link href={t.href} className="flex flex-col gap-1 px-5 py-2.5 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
            <span className="min-w-0">
              <span className="block truncate text-[13px] font-medium text-fg">{t.title}</span>
              <span className="block truncate text-[12px] text-fg-3">
                {t.projectName} · {t.assigneeId ? (names.get(t.assigneeId) ?? "Member") : "Unassigned"}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              <PriorityBadge value={t.priority} />
              {t.dueDate && <span className="text-[12px] text-fg-3">Due {t.dueDate}</span>}
              <StatusBadge kind="task" value={t.status} label={isTaskStatus(t.status) ? TASK_STATUS_LABELS[t.status] : t.status} />
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default async function OrganizationOverviewPage({ params }: PageProps<"/organizations/[organizationId]/overview">) {
  const { organizationId } = await params;
  const access = await getOrgAccess(organizationId);
  if (!access) notFound();
  const { organization, role, user } = access;
  const manager = access.can("tasks.assign");
  const base = `/organizations/${organization.id}`;
  // No scheduler: expired invitations are closed (inviters notified) when a manager opens this page.
  if (manager) await closeExpiredInvitations(organization.id);

  const [counts, tasks, handoffs, mode, workload, audit] = await Promise.all([
    getStructureCounts(organization.id),
    listOpenOrganizationTasks(organization.id),
    listPendingHandoffs(organization.id),
    getAssignmentMode(organization.id),
    manager ? getWorkloadSummary(organization.id) : Promise.resolve([]),
    access.can("audit.view") ? listAuditEvents(organization.id, 8) : Promise.resolve([]),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const names = await profileNames([...tasks.map((t) => t.assigneeId), ...audit.map((e) => e.actor_id)]);
  const queue = tasks.filter((t) => t.assigneeId === null && (t.status === "TODO" || t.status === "BLOCKED"));
  const blocked = tasks.filter((t) => t.status === "BLOCKED");
  const overdue = tasks.filter((t) => t.dueDate && t.dueDate < today);
  const review = tasks.filter((t) => t.status === "IN_REVIEW" || t.status === "IN_QA");
  const mine = tasks.filter((t) => t.assigneeId === user.id);

  return (
    <PageBody>
      <PageHeader
        crumbs={[{ label: organization.name }, { label: "Overview" }]}
        icon={<IconBuilding size={18} />}
        title={organization.name}
        description={manager ? "Work, people and policy of this organization at a glance." : "Your work and the structure of this organization."}
        badges={<StatusBadge kind="role" value={role} label={`You: ${ROLE_LABELS[role]}`} />}
        actions={
          access.can("org.settings.view") ? (
            <ButtonLink href={`${base}/settings`} variant="secondary">
              <IconSettings size={15} />
              Settings
            </ButtonLink>
          ) : undefined
        }
      />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {manager ? (
          <>
            <MetricCard label="Open tasks" value={tasks.length} icon={<IconTask size={15} />} hint="To do, in progress, blocked, review, QA" />
            <MetricCard label="Unassigned" value={queue.length} icon={<IconUsers size={15} />} hint="Waiting in the assignment queue" />
            <MetricCard label="Blocked" value={blocked.length} icon={<IconActivity size={15} />} hint="Reason recorded on each task" />
            <MetricCard label="Overdue" value={overdue.length} icon={<IconActivity size={15} />} hint="Past their due date" />
          </>
        ) : (
          <>
            <MetricCard label="Your open tasks" value={mine.length} icon={<IconTask size={15} />} hint={<Link href="/my-work" className="hover:text-accent">Open My work</Link>} />
            <MetricCard label="Departments" value={counts.departments} icon={<IconLayers size={15} />} />
            <MetricCard label="Teams" value={counts.teams} icon={<IconUsers size={15} />} />
            <MetricCard label="Members" value={counts.members} icon={<IconUsers size={15} />} />
          </>
        )}
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          {manager && (
            <section>
              <SectionHeader title={`Assignment queue (${queue.length})`} description={MODE_TEXT[mode] ?? mode} />
              <Card className="overflow-hidden">
                <TaskRows tasks={queue.slice(0, 15)} names={names} empty="Every open task has an assignee." />
                {mode === "AUTO" && queue.length > 0 && (
                  <div className="border-t border-border px-5 py-3">
                    <AssignQueueButton organizationId={organization.id} count={queue.filter((t) => t.status === "TODO").length} />
                  </div>
                )}
              </Card>
            </section>
          )}

          {manager && (
            <section>
              <SectionHeader title={`Blocked and overdue (${new Set([...blocked, ...overdue].map((t) => t.id)).size})`} description="Tasks that need attention." />
              <Card className="overflow-hidden">
                <TaskRows tasks={[...new Map([...blocked, ...overdue].map((t) => [t.id, t])).values()].slice(0, 15)} names={names} empty="Nothing blocked or overdue." />
              </Card>
            </section>
          )}

          {manager && (
            <section>
              <SectionHeader title={`In review and QA (${review.length})`} description="Submitted work waiting for approval or testing." />
              <Card className="overflow-hidden">
                <TaskRows tasks={review.slice(0, 15)} names={names} empty="Nothing waiting for review or testing." />
              </Card>
            </section>
          )}

          {!manager && (
            <section>
              <SectionHeader title={`Your open tasks here (${mine.length})`} description="Assigned to you in this organization." />
              {mine.length === 0 ? (
                <EmptyState compact icon={<IconTask size={20} />} title="Nothing assigned to you here" description="Tasks an owner or admin assigns to you appear here and in My work." />
              ) : (
                <Card className="overflow-hidden">
                  <TaskRows tasks={mine} names={names} empty="" />
                </Card>
              )}
            </section>
          )}

          <section>
            <SectionHeader title={`Pending handoffs (${handoffs.length})`} description="Work passed between teams and not yet accepted." />
            <Card className="overflow-hidden">
              {handoffs.length === 0 ? (
                <p className="t-small px-5 py-4 text-fg-3">No pending handoffs.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {handoffs.map((h) => (
                    <li key={h.id}>
                      <Link href={h.task.href} className="block px-5 py-2.5 transition-colors hover:bg-surface-2">
                        <span className="block text-[13px] font-medium text-fg">
                          {h.task.title} <span className="font-normal text-fg-3">→ {h.team}</span>
                        </span>
                        <span className="block truncate text-[12px] text-fg-2">{h.summary}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </section>
        </div>

        <aside className="flex h-fit flex-col gap-4">
          <Card>
            <CardHeader title="Structure" />
            <ul className="flex flex-col gap-1.5 px-5 py-4 text-[13px]">
              <li className="flex justify-between"><Link href={`${base}/departments`} className="text-fg hover:underline">Departments</Link><span className="text-fg-3">{counts.departments}</span></li>
              <li className="flex justify-between"><span className="text-fg-2">Teams</span><span className="text-fg-3">{counts.teams}</span></li>
              <li className="flex justify-between"><span className="text-fg-2">Projects you can see</span><span className="text-fg-3">{counts.projects}</span></li>
              <li className="flex justify-between"><Link href={`${base}/members`} className="text-fg hover:underline">Active members</Link><span className="text-fg-3">{counts.members}</span></li>
            </ul>
          </Card>

          {manager && (
            <Card>
              <CardHeader title="Workload" description="Active tasks and estimated hours per person." />
              {workload.length === 0 ? (
                <p className="t-small px-5 py-4 text-fg-3">No workload data.</p>
              ) : (
                <ul className="divide-y divide-border">
                  {workload.slice(0, 8).map((w) => (
                    <li key={w.user_id} className="flex items-center justify-between gap-2 px-5 py-2 text-[13px]">
                      <span className="truncate text-fg">{w.name}</span>
                      <span className="shrink-0 text-[12px] text-fg-3">
                        {w.active_tasks} tasks · {Number(w.active_hours)} h{w.unestimated_tasks ? ` + ${w.unestimated_tasks} unestimated` : ""}
                        {w.blocked ? ` · ${w.blocked} blocked` : ""}
                        {w.overdue ? ` · ${w.overdue} overdue` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-border px-5 py-2.5">
                <Link href={`${base}/workforce`} className="text-[12.5px] text-fg-3 hover:text-fg">Open the workforce directory</Link>
              </div>
            </Card>
          )}

          {audit.length > 0 && (
            <Card>
              <CardHeader title="Recent activity" icon={<IconActivity size={16} />} />
              <ol className="divide-y divide-border">
                {audit.map((e) => (
                  <li key={e.id} className="px-5 py-2 text-[12.5px] text-fg-2">
                    <span className="text-fg">{(e.actor_id && names.get(e.actor_id)) || "Someone"}</span> {e.action.replace(/^[a-z]+\./, "").replaceAll("_", " ")}
                    <span className="block text-[12px] text-fg-3">{formatDateTime(e.created_at)}</span>
                  </li>
                ))}
              </ol>
              <div className="border-t border-border px-5 py-2.5">
                <Link href={`${base}/members`} className="text-[12.5px] text-fg-3 hover:text-fg">All membership activity</Link>
              </div>
            </Card>
          )}
        </aside>
      </div>
    </PageBody>
  );
}
