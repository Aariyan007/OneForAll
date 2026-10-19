import Link from "next/link";
import { Card } from "@/components/ui/card";
import { EmptyState, MetricCard } from "@/components/ui/data";
import { IconActivity, IconBell, IconTask, IconUsers } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { PriorityBadge, StatusBadge } from "@/components/ui/status";
import { TASK_STATUS_LABELS, isTaskStatus } from "@/lib/tasks/workflow";
import { requireUser } from "@/server/auth/session";
import { listMyWorkspaces } from "@/lib/workspaces";
import { type MyTask, listHandoffsToMyTeams, listMyQaQueue, listMyReviewQueue, listMyTasks } from "@/server/my-work/queries";
import { countUnreadNotifications } from "@/server/notifications/queries";

export const metadata = { title: "My work · OneForAll" };

// Today's date as an ISO day, computed once per request outside of components.
function today() {
  return new Date().toISOString().slice(0, 10);
}

// Groups of the person's own tasks. "Up next" is ready to start; "Upcoming" waits on unfinished dependencies.
const GROUPS: { key: string; title: string; text: string; pick: (t: MyTask) => boolean; limit?: number }[] = [
  { key: "in-progress", title: "In progress", text: "What you are working on.", pick: (t) => t.status === "IN_PROGRESS" },
  { key: "blocked", title: "Blocked", text: "Waiting on something; the reason is on the task.", pick: (t) => t.status === "BLOCKED" },
  { key: "up-next", title: "Up next", text: "Assigned to you and ready to start.", pick: (t) => t.status === "TODO" && t.openDependencies === 0 },
  { key: "upcoming", title: "Upcoming", text: "Assigned to you; starts when the tasks it depends on are finished.", pick: (t) => t.status === "TODO" && t.openDependencies > 0 },
  { key: "in-review", title: "In review", text: "Submitted; an owner or admin reviews it.", pick: (t) => t.status === "IN_REVIEW" },
  { key: "in-qa", title: "In QA", text: "Review approved; your team tests it. Defects come back to you.", pick: (t) => t.status === "IN_QA" },
  { key: "completed", title: "Completed", text: "Recently finished.", pick: (t) => t.status === "COMPLETED", limit: 10 },
];

function TaskList({ tasks, todayIso }: { tasks: MyTask[]; todayIso: string }) {
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-border">
        {tasks.map((t) => (
          <li key={t.id}>
            <Link href={t.href} className="flex flex-col gap-1 px-5 py-3 transition-colors hover:bg-surface-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="truncate text-[13.5px] font-medium text-fg">{t.title}</p>
                <p className="truncate text-[12px] text-fg-3">
                  {t.path.organizationName} · {t.path.projectName} · {t.path.requirementTitle}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <PriorityBadge value={t.priority} />
                {t.dueDate && (
                  <span className={t.dueDate < todayIso && t.status !== "COMPLETED" ? "text-[12px] font-medium text-warning" : "text-[12px] text-fg-3"}>
                    Due {t.dueDate}
                  </span>
                )}
                <StatusBadge kind="task" value={t.status} label={isTaskStatus(t.status) ? TASK_STATUS_LABELS[t.status] : t.status} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export default async function MyWorkPage() {
  const user = await requireUser();
  const workspaces = await listMyWorkspaces(user.id);
  const managed = workspaces.filter((w) => w.role === "OWNER" || w.role === "ADMIN").map((w) => w.id);
  const [tasks, handoffs, unread, qaQueue, reviewQueue] = await Promise.all([
    listMyTasks(user.id),
    listHandoffsToMyTeams(user.id),
    countUnreadNotifications(),
    listMyQaQueue(user.id),
    listMyReviewQueue(managed),
  ]);
  const todayIso = today();
  const active = tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED");
  const overdue = active.filter((t) => t.dueDate && t.dueDate < todayIso).length;

  return (
    <PageBody>
      <PageHeader crumbs={[{ label: "My work" }]} icon={<IconTask size={18} />} title="My work" description="Tasks assigned to you and work handed to your teams, across your organizations." />

      <div className="grid gap-3 sm:grid-cols-4">
        <MetricCard label="Active" value={active.length} icon={<IconTask size={15} />} hint="Assigned to you" />
        <MetricCard label="Blocked" value={active.filter((t) => t.status === "BLOCKED").length} icon={<IconActivity size={15} />} hint="Waiting on something" />
        <MetricCard label="Overdue" value={overdue} icon={<IconActivity size={15} />} hint="Past the due date" />
        <MetricCard label="Unread" value={unread} icon={<IconBell size={15} />} hint={<Link href="/notifications" className="hover:text-accent">Open notifications</Link>} />
      </div>

      <div className="mt-8 flex flex-col gap-8">
        {reviewQueue.length > 0 && (
          <section>
            <SectionHeader title={`To review (${reviewQueue.length})`} description="Submitted work in organizations you manage: approve, send to QA, or request changes." />
            <TaskList tasks={reviewQueue} todayIso={todayIso} />
          </section>
        )}

        {qaQueue.length > 0 && (
          <section>
            <SectionHeader title={`To test (${qaQueue.length})`} description="In QA for a team you belong to. Pass it, or report defects." />
            <TaskList tasks={qaQueue} todayIso={todayIso} />
          </section>
        )}

        {handoffs.length > 0 && (
          <section>
            <SectionHeader title={`Handed to your teams (${handoffs.length})`} icon={<IconUsers size={16} />} description="Accept to take over, or decline with a note." />
            <Card className="overflow-hidden">
              <ul className="divide-y divide-border">
                {handoffs.map((h) => (
                  <li key={h.id}>
                    <Link href={h.task.href} className="block px-5 py-3 transition-colors hover:bg-surface-2">
                      <p className="text-[13.5px] font-medium text-fg">
                        {h.task.title} <span className="font-normal text-fg-3">→ {h.team}</span>
                      </p>
                      <p className="truncate text-[12.5px] text-fg-2">{h.summary}</p>
                      <p className="text-[12px] text-fg-3">
                        {h.task.path.organizationName} · {h.task.path.projectName}
                      </p>
                    </Link>
                  </li>
                ))}
              </ul>
            </Card>
          </section>
        )}

        {tasks.length === 0 ? (
          <EmptyState icon={<IconTask size={20} />} title="Nothing assigned to you" description="When an owner or admin assigns you a task, it appears here with its priority, due date and acceptance criteria." />
        ) : (
          GROUPS.map((g) => {
            const list = tasks.filter(g.pick).slice(0, g.limit ?? 100);
            if (list.length === 0) return null;
            return (
              <section key={g.key}>
                <SectionHeader title={`${g.title} (${list.length})`} description={g.text} />
                <TaskList tasks={list} todayIso={todayIso} />
              </section>
            );
          })
        )}
      </div>
    </PageBody>
  );
}
