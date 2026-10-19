import { notFound } from "next/navigation";
import {
  AssignmentPanel,
  CommentForm,
  DeclineAssignment,
  DefectReportForm,
  DependencyEditor,
  HandoffForm,
  HandoffResponse,
  LinkForm,
  PlanningForm,
  RemoveLinkButton,
  ResolveDefectButton,
  RequiredSkillsEditor,
  TaskStatusActions,
} from "@/components/tasks/task-controls";
import { Card, CardHeader } from "@/components/ui/card";
import { Avatar, KeyValueList, formatDateTime } from "@/components/ui/data";
import { IconActivity, IconTask } from "@/components/ui/icons";
import { PageBody, PageHeader } from "@/components/ui/page";
import { PriorityBadge, StatusBadge } from "@/components/ui/status";
import { can } from "@/lib/authz/permissions";
import { TASK_STATUS_LABELS, availableActions, isTaskStatus } from "@/lib/tasks/workflow";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { getAssignmentRanking } from "@/server/tasks/assignment";
import { getTaskContext, getTaskDetail } from "@/server/tasks/detail";
import { getAssignmentMode, listSkills } from "@/server/workforce/queries";

export const metadata = { title: "Task · OneForAll" };

const EVENT_TEXT: Record<string, string> = {
  CREATED: "created the task",
  ASSIGNED: "assigned the task",
  UNASSIGNED: "unassigned the task",
  COMMENTED: "commented",
  DEPENDENCY_ADDED: "added a dependency",
  DEPENDENCY_REMOVED: "removed a dependency",
  SKILLS_CHANGED: "changed the required skills",
  HANDOFF_CREATED: "handed the task off",
  HANDOFF_ACCEPTED: "accepted the handoff",
  HANDOFF_DECLINED: "declined the handoff",
  HANDOFF_CANCELLED: "cancelled the handoff",
  DECLINED: "declined the assignment",
  DEFECT_REPORTED: "reported a defect",
  DEFECT_RESOLVED: "resolved a defect",
  DUE_DATE_CHANGED: "changed the due date",
  QA_REQUIREMENT_CHANGED: "changed whether QA is required",
  LINK_ADDED: "added a link",
  LINK_REMOVED: "removed a link",
};

const SEVERITY_TONE: Record<string, string> = { LOW: "text-fg-3", MEDIUM: "text-fg-2", HIGH: "text-warning", CRITICAL: "text-danger" };

export default async function TaskPage({
  params,
}: PageProps<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/requirements/[requirementId]/tasks/[taskId]">) {
  const ids = await params;
  const user = await requireUser();
  const context = await getTaskContext(ids);
  if (!context) notFound();
  const { organization, department, team, project, requirement, task } = context;
  const role = organization.role;
  const manager = can(role, "tasks.assign");
  const isAssignee = task.assignee_id === user.id;
  const status = isTaskStatus(task.status) ? task.status : "TODO";

  const detail = await getTaskDetail(context);
  const assignable = !["COMPLETED", "CANCELLED", "IN_REVIEW", "IN_QA"].includes(status);
  const [skills, mode, ranking] = await Promise.all([
    manager ? listSkills(organization.id) : Promise.resolve([]),
    getAssignmentMode(organization.id),
    manager && assignable ? getAssignmentRanking(task) : Promise.resolve(null),
  ]);
  // Teams the viewer belongs to, for answering handoffs and testing (team_members is visible to organization members).
  const supabase = await createClient();
  const { data: myTeams } = await supabase.from("team_members").select("team_id").eq("user_id", user.id);
  const myTeamIds = new Set((myTeams ?? []).map((t) => t.team_id));
  const responsibleTeam = task.team_id ?? team.id;
  // Mirrors private.can_test_task(): a manager, or a member of the responsible team who is not the assignee.
  const tester = !isAssignee && (manager || myTeamIds.has(responsibleTeam));

  const openDependencies = detail.dependencies.filter((d) => d.status !== "COMPLETED" && d.status !== "CANCELLED").length;
  const openDefects = detail.defects.filter((d) => d.status === "OPEN").length;
  const actions = availableActions(
    status,
    { manager, assignee: isAssignee, tester },
    { assigned: Boolean(task.assignee_id), openDependencies, openDefects, qaRequired: task.qa_required },
  );

  const projectPath = `/organizations/${organization.id}/departments/${department.id}/teams/${team.id}/projects/${project.id}`;
  const taskHref = (requirementId: string, taskId: string) => `${projectPath}/requirements/${requirementId}/tasks/${taskId}`;
  const handoffTargets = detail.projectTeams.filter((t) => t.id !== responsibleTeam);
  const pendingHandoff = detail.handoffs.find((h) => h.status === "PENDING");
  const nameOf = (id: string | null) => (id ? (detail.names.get(id) ?? "Member") : "Someone");
  const taskIds = { ...ids };

  return (
    <PageBody>
      <PageHeader
        crumbs={[
          { label: project.name, href: projectPath },
          { label: requirement.title, href: `${projectPath}/requirements/${requirement.id}` },
          { label: task.title },
        ]}
        icon={<IconTask size={18} />}
        title={task.title}
        badges={
          <>
            <StatusBadge kind="task" value={status} label={TASK_STATUS_LABELS[status]} />
            <PriorityBadge value={task.priority} />
            {task.due_date && <span className="text-[12px] text-fg-3">Due {task.due_date}</span>}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-5">
          <Card>
            <CardHeader title="What to do" description={`Part of the requirement “${requirement.title}”.`} />
            <div className="flex flex-col gap-4 px-5 py-4">
              {task.description ? <p className="t-body whitespace-pre-line text-fg-2">{task.description}</p> : <p className="t-small text-fg-3">No description.</p>}
              <div>
                <h3 className="text-[13px] font-medium text-fg">Acceptance criteria</h3>
                {task.acceptance_criteria ? <p className="t-body mt-1 whitespace-pre-line text-fg-2">{task.acceptance_criteria}</p> : <p className="t-small mt-1 text-fg-3">None recorded.</p>}
              </div>
              <div>
                <h3 className="text-[13px] font-medium text-fg">Required skills</h3>
                <p className="mt-1 flex flex-wrap gap-1">
                  {detail.requiredSkills.length === 0 ? (
                    <span className="t-small text-fg-3">None set.</span>
                  ) : (
                    detail.requiredSkills.map((s) => (
                      <span key={s.id} className="rounded-full border border-border-strong px-2 py-0.5 text-[12px] text-fg-2">
                        {s.name}
                      </span>
                    ))
                  )}
                </p>
              </div>
            </div>
          </Card>

          <Card>
            <CardHeader
              title="Status"
              description={
                isAssignee
                  ? "You are working on this task."
                  : manager
                    ? "As an owner or admin you review and can move the task."
                    : tester && status === "IN_QA"
                      ? "Your team tests this task: pass it, or fail it with what went wrong."
                      : "Only the assignee, testers and admins change the status."
              }
            />
            <div className="flex flex-col gap-3 px-5 py-4">
              <TaskStatusActions ids={taskIds} actions={actions} />
              {task.qa_required && status !== "COMPLETED" && status !== "CANCELLED" && (
                <p className="t-small text-fg-3">QA is required: after the review is approved, the responsible team tests the task before it is completed.</p>
              )}
              {isAssignee && status === "TODO" && <DeclineAssignment ids={taskIds} />}
            </div>
          </Card>

          {(detail.defects.length > 0 || (tester && (status === "IN_QA" || status === "COMPLETED"))) && (
            <Card>
              <CardHeader
                title={`Defects${openDefects > 0 ? ` (${openDefects} open)` : ""}`}
                description="Found in testing. Open defects must be resolved before the task can enter QA or be completed."
              />
              <div className="flex flex-col gap-3 px-5 py-4">
                {detail.defects.length > 0 && (
                  <ul className="flex flex-col gap-2">
                    {detail.defects.map((d) => (
                      <li key={d.id} className="rounded-lg border border-border p-3">
                        <div className="flex flex-wrap items-center gap-2 text-[13px]">
                          <StatusBadge kind="defect" value={d.status} />
                          <span className={`text-[12px] font-medium ${SEVERITY_TONE[d.severity] ?? "text-fg-2"}`}>{d.severity.toLowerCase()}</span>
                          <span className="font-medium text-fg">{d.title}</span>
                        </div>
                        {d.details && <p className="t-small mt-1 whitespace-pre-line text-fg-2">{d.details}</p>}
                        <p className="mt-1 text-[12px] text-fg-3">
                          Reported by {nameOf(d.reported_by)}, {formatDateTime(d.reported_at)}
                          {d.status === "RESOLVED" && d.resolved_at && (
                            <>
                              {" "}
                              · resolved by {nameOf(d.resolved_by)}, {formatDateTime(d.resolved_at)}
                              {d.resolution && <>: “{d.resolution}”</>}
                            </>
                          )}
                        </p>
                        {d.status === "OPEN" && (isAssignee || manager) && <ResolveDefectButton ids={taskIds} defectId={d.id} />}
                      </li>
                    ))}
                  </ul>
                )}
                {tester && (status === "IN_QA" || status === "COMPLETED") && <DefectReportForm ids={taskIds} />}
              </div>
            </Card>
          )}

          <Card>
            <CardHeader title="Dependencies" description="Work that must be finished before this task can start or be completed." />
            <div className="flex flex-col gap-4 px-5 py-4">
              <DependencyEditor ids={taskIds} dependencies={detail.dependencies} options={detail.projectTasks} requirementsHref={`${projectPath}/requirements`} editable={manager} />
              {detail.dependents.length > 0 && (
                <div>
                  <h3 className="text-[12.5px] text-fg-3">Waiting on this task</h3>
                  <ul className="mt-1 flex flex-col gap-0.5 text-[13px]">
                    {detail.dependents.map((d) => (
                      <li key={d.id}>
                        {d.requirementId ? <a href={taskHref(d.requirementId, d.id)} className="text-fg hover:underline">{d.title}</a> : d.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          <Card>
            <CardHeader title="Links" description="Pull requests, commits, designs or documents for this task (https only)." />
            <div className="flex flex-col gap-3 px-5 py-4">
              {detail.links.length === 0 ? (
                <p className="t-small text-fg-3">No links yet.</p>
              ) : (
                <ul className="flex flex-col gap-1.5">
                  {detail.links.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-2 text-[13px]">
                      <a href={l.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-fg underline-offset-2 hover:underline">
                        {l.label || l.url}
                      </a>
                      <span className="text-[12px] text-fg-3">added by {nameOf(l.created_by)}</span>
                      {(manager || isAssignee || l.created_by === user.id) && <RemoveLinkButton ids={taskIds} linkId={l.id} />}
                    </li>
                  ))}
                </ul>
              )}
              {(manager || isAssignee) && <LinkForm ids={taskIds} />}
            </div>
          </Card>

          <Card>
            <CardHeader title="Handoffs" description="Pass the task to another team working on this project, with the context they need." />
            <div className="flex flex-col gap-4 px-5 py-4">
              {detail.handoffs.length > 0 && (
                <ul className="flex flex-col gap-3">
                  {detail.handoffs.map((h) => (
                    <li key={h.id} className="rounded-lg border border-border p-3">
                      <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-fg-2">
                        <StatusBadge kind="handoff" value={h.status} />
                        <span>
                          {detail.teamName.get(h.from_team_id ?? "") ?? "A team"} → <span className="text-fg">{detail.teamName.get(h.to_team_id) ?? "a team"}</span>, by {nameOf(h.created_by)},{" "}
                          {formatDateTime(h.created_at)}
                        </span>
                      </div>
                      <dl className="mt-2 grid gap-1.5 text-[13px]">
                        <div><dt className="text-fg-3">Completed</dt><dd className="whitespace-pre-line text-fg-2">{h.summary}</dd></div>
                        {h.remaining_work && <div><dt className="text-fg-3">Remaining</dt><dd className="whitespace-pre-line text-fg-2">{h.remaining_work}</dd></div>}
                        {h.notes && <div><dt className="text-fg-3">Notes</dt><dd className="whitespace-pre-line text-fg-2">{h.notes}</dd></div>}
                        {h.response_note && <div><dt className="text-fg-3">Response</dt><dd className="text-fg-2">{h.response_note} ({nameOf(h.responded_by)})</dd></div>}
                      </dl>
                      {h.status === "PENDING" && (
                        <HandoffResponse ids={taskIds} handoffId={h.id} canRespond={manager || myTeamIds.has(h.to_team_id)} canCancel={manager || h.created_by === user.id} />
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {!pendingHandoff && (isAssignee || manager) && status !== "CANCELLED" && <HandoffForm ids={taskIds} teams={handoffTargets} />}
            </div>
          </Card>

          <Card>
            <CardHeader title="Comments and activity" icon={<IconActivity size={16} />} />
            <div className="flex flex-col gap-5 px-5 py-4">
              <ol className="flex flex-col gap-3">
                {detail.comments.map((c) => (
                  <li key={c.id} className="flex gap-2.5">
                    <Avatar name={nameOf(c.author_id)} size="sm" />
                    <div className="min-w-0">
                      <p className="text-[12.5px] text-fg-3">
                        <span className="font-medium text-fg">{nameOf(c.author_id)}</span> · {formatDateTime(c.created_at)}
                      </p>
                      <p className="t-body whitespace-pre-line text-fg-2">{c.body}</p>
                    </div>
                  </li>
                ))}
              </ol>
              <CommentForm ids={taskIds} mentionable={detail.mentionable} />
              <details>
                <summary className="cursor-pointer text-[12.5px] text-fg-3 hover:text-fg">Activity log ({detail.events.length})</summary>
                <ol className="mt-2 flex flex-col gap-1.5">
                  {detail.events.map((e) => {
                    const reason = e.details && typeof e.details === "object" && !Array.isArray(e.details) && typeof e.details.reason === "string" ? e.details.reason : null;
                    return (
                      <li key={e.id} className="text-[12.5px] text-fg-2">
                        <span className="text-fg">{nameOf(e.actor_id)}</span>{" "}
                        {e.event_type === "STATUS_CHANGED" && e.from_status && e.to_status && isTaskStatus(e.from_status) && isTaskStatus(e.to_status)
                          ? `moved it from ${TASK_STATUS_LABELS[e.from_status]} to ${TASK_STATUS_LABELS[e.to_status]}`
                          : (EVENT_TEXT[e.event_type] ?? e.event_type.toLowerCase())}
                        {reason && <span className="text-fg-3">: “{reason}”</span>} <span className="text-fg-3">· {formatDateTime(e.created_at)}</span>
                      </li>
                    );
                  })}
                </ol>
              </details>
            </div>
          </Card>
        </div>

        <aside className="flex h-fit flex-col gap-4">
          <Card>
            <CardHeader title="Details" />
            <div className="px-5 py-4">
              <KeyValueList
                items={[
                  { label: "Assignee", value: task.assignee_id ? nameOf(task.assignee_id) : "Unassigned" },
                  { label: "Responsible team", value: detail.teamName.get(responsibleTeam) ?? team.name },
                  { label: "Estimate", value: task.estimated_hours != null ? `${task.estimated_hours} h` : "Not estimated" },
                  { label: "Due", value: task.due_date ?? "No due date" },
                  { label: "QA", value: task.qa_required ? "Required" : "Not required" },
                  { label: "Created", value: `${formatDateTime(task.created_at)} by ${nameOf(task.created_by)}` },
                ]}
              />
            </div>
          </Card>

          {manager && (
            <Card>
              <CardHeader
                title="Assignment"
                description={mode === "MANUAL" ? "Manual: you choose. Eligibility and workload are shown." : mode === "RECOMMEND" ? "Recommendation first: confirm or choose someone else." : "Automatic assignment is enabled for this organization."}
              />
              <div className="px-5 py-4">
                {ranking ? (
                  <AssignmentPanel
                    ids={taskIds}
                    currentAssigneeId={task.assignee_id}
                    ranked={ranking.ranking.ranked.map((c) => ({ userId: c.userId, name: c.name, availability: c.availability, reasons: c.reasons, overloaded: c.overloaded }))}
                    ineligible={ranking.ranking.ineligible.map((i) => ({ userId: i.candidate.userId, name: i.candidate.name, reason: i.reason }))}
                    note={ranking.ranking.note}
                    mode={mode}
                    assignable={assignable}
                  />
                ) : (
                  <p className="t-small text-fg-3">{assignable ? "Candidates could not be loaded." : "Completed, cancelled, in-review and in-QA tasks cannot be reassigned."}</p>
                )}
              </div>
            </Card>
          )}

          {manager && (
            <Card>
              <CardHeader title="Planning" />
              <div className="flex flex-col gap-5 px-5 py-4">
                <PlanningForm ids={taskIds} values={{ acceptanceCriteria: task.acceptance_criteria, estimatedHours: task.estimated_hours, dueDate: task.due_date, qaRequired: task.qa_required }} />
                <div>
                  <h3 className="mb-2 text-[13px] font-medium text-fg">Required skills</h3>
                  <RequiredSkillsEditor ids={taskIds} skills={skills} selected={detail.requiredSkills.map((s) => s.id)} />
                </div>
              </div>
            </Card>
          )}
        </aside>
      </div>
    </PageBody>
  );
}
