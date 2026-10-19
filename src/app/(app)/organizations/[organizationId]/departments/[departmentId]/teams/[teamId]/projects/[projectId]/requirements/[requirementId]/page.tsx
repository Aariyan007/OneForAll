import { notFound } from "next/navigation";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState, KeyValueList } from "@/components/ui/data";
import { IconListChecks, IconPlus, IconTask } from "@/components/ui/icons";
import { PageBody, PageHeader, SectionHeader } from "@/components/ui/page";
import { RequirementStatusActions } from "@/components/work-items/requirement-status";
import { REQUIREMENT_STATUSES, type RequirementStatus } from "@/server/requirements/schema";
import { PriorityBadge, StatusBadge, humanize, toneFor } from "@/components/ui/status";
import { getMyRequirement, getProjectContext } from "@/server/requirements/queries";
import { TASK_STATUSES } from "@/server/tasks/schema";
import { listTasks } from "@/server/tasks/queries";
import Link from "next/link";
import { cx } from "@/lib/cx";
import { TASK_STATUS_LABELS } from "@/lib/tasks/workflow";

export const metadata = { title: "Requirement · OneForAll" };

const COLUMN_ACCENT: Record<string, string> = {
  neutral: "bg-fg-3",
  accent: "bg-accent",
  success: "bg-success",
  muted: "bg-border-strong",
  danger: "bg-danger",
  info: "bg-info",
};

export default async function RequirementPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/requirements/[requirementId]">) {
  const { organizationId, departmentId, teamId, projectId, requirementId } = await params;
  const context = await getProjectContext(organizationId, departmentId, teamId, projectId);
  if (!context) notFound();
  const { organization, department, team, project, canManage } = context;

  // Scoped to this project and RLS-filtered: a requirement from another project or tenant is simply not found.
  const requirement = await getMyRequirement(project.id, requirementId);
  if (!requirement) notFound();

  const tasks = await listTasks(requirement.id);
  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const base = `${projectPath}/requirements`;
  const done = tasks.filter((t) => t.status === "COMPLETED").length;
  const progress = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: "Requirements", href: base },
          { label: requirement.title },
        ]}
        icon={<IconListChecks size={18} />}
        title={requirement.title}
        badges={
          <>
            <StatusBadge kind="requirement" value={requirement.status} />
            <PriorityBadge value={requirement.priority} />
          </>
        }
        actions={
          /* UI hint only. The database enforces who may actually create tasks. */
          canManage && (
            <ButtonLink href={`${base}/${requirement.id}/tasks/new`} variant="primary">
              <IconPlus size={15} />
              New task
            </ButtonLink>
          )
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="flex min-w-0 flex-col gap-8">
          <Card>
            <CardHeader title="Description" />
            <div className="px-5 py-4">
              {requirement.description ? (
                <p className="t-body whitespace-pre-line text-fg-2">{requirement.description}</p>
              ) : (
                <p className="t-small text-fg-3">No description provided.</p>
              )}
            </div>
          </Card>

          <section>
            <SectionHeader title="Tasks" description={`${tasks.length} ${tasks.length === 1 ? "task" : "tasks"} for this requirement`} icon={<IconTask size={16} />} />
            {tasks.length === 0 ? (
              <EmptyState
                compact
                icon={<IconTask size={20} />}
                title="No tasks yet"
                description="Break this requirement into concrete tasks your team can pick up."
                action={
                  canManage && (
                    <ButtonLink href={`${base}/${requirement.id}/tasks/new`} variant="primary">
                      <IconPlus size={15} />
                      Create task
                    </ButtonLink>
                  )
                }
              />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {TASK_STATUSES.map((status) => {
                  const column = tasks.filter((task) => task.status === status);
                  return (
                    <div key={status} className="flex min-w-0 flex-col rounded-xl border border-border bg-bg-subtle/60">
                      <div className="flex items-center gap-2 px-3 py-2.5">
                        <span className={cx("size-2 rounded-full", COLUMN_ACCENT[toneFor("task", status)] ?? "bg-fg-3")} />
                        <span className="text-[12.5px] font-medium text-fg-2">{TASK_STATUS_LABELS[status] ?? humanize(status)}</span>
                        <span className="ml-auto rounded bg-surface-3 px-1.5 text-[11px] tabular-nums text-fg-3">{column.length}</span>
                      </div>
                      <ul className="flex flex-col gap-2 px-2 pb-2">
                        {column.length === 0 && <li className="rounded-lg border border-dashed border-border px-3 py-4 text-center text-[12px] text-fg-3">No tasks</li>}
                        {column.map((task) => (
                          <li key={task.id}>
                            <Link
                              href={`${base}/${requirement.id}/tasks/${task.id}`}
                              className="block rounded-lg border border-border bg-surface p-3 shadow-1 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-accent"
                            >
                              <p className="text-[13px] font-medium leading-snug text-fg">{task.title}</p>
                              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                                <PriorityBadge value={task.priority} />
                                <span className="text-[11.5px] text-fg-3">{task.assigneeName ?? "Unassigned"}</span>
                                {task.due_date && <span className="text-[11.5px] text-fg-3">· due {task.due_date}</span>}
                              </div>
                            </Link>
                          </li>
                        ))}
                      </ul>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </div>

        <aside className="grid h-fit gap-3 sm:grid-cols-2 xl:flex xl:flex-col">
          {canManage && isRequirementStatus(requirement.status) && (
            <Card>
              <CardHeader title="Requirement status" description="Release readiness: complete it when every task is done." />
              <div className="px-5 py-4">
                <RequirementStatusActions
                  ids={{ organizationId: organization.id, departmentId: department.id, teamId: team.id, projectId: project.id, requirementId: requirement.id }}
                  status={requirement.status}
                  openTasks={tasks.filter((t) => t.status !== "COMPLETED" && t.status !== "CANCELLED").length}
                />
              </div>
            </Card>
          )}
          <Card>
            <CardHeader title="Details" />
            <div className="px-5 py-4">
              <KeyValueList
                items={[
                  { label: "Status", value: <StatusBadge kind="requirement" value={requirement.status} /> },
                  { label: "Priority", value: <PriorityBadge value={requirement.priority} /> },
                  { label: "Project", value: project.name },
                  { label: "Tasks", value: tasks.length },
                ]}
              />
            </div>
          </Card>
          {tasks.length > 0 && (
            <Card className="px-5 py-4">
              <div className="flex items-center justify-between">
                <span className="t-caption text-fg-3">Task progress</span>
                <span className="t-small tabular-nums text-fg-2">
                  {done}/{tasks.length}
                </span>
              </div>
              <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-surface-3">
                <div className="h-full rounded-full bg-success" style={{ width: `${progress}%` }} />
              </div>
              <p className="t-small mt-2 text-fg-3">{progress}% completed</p>
            </Card>
          )}
        </aside>
      </div>
    </PageBody>
  );
}

function isRequirementStatus(value: string): value is RequirementStatus {
  return (REQUIREMENT_STATUSES as readonly string[]).includes(value);
}
