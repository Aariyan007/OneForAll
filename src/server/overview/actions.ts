"use server";

import { getOrgAccess } from "@/server/authz/access";
import { autoAssignTask } from "@/server/tasks/workflow-actions";
import { getAssignmentMode } from "@/server/workforce/queries";
import { listOpenOrganizationTasks } from "./queries";

export type QueueResult = { error?: string; success?: string };

// Automatic assignment of the organization's queue (owners/admins, AUTO policy only): every unassigned task that has
// not started is offered to autoAssignTask(), which re-verifies the task, ranks candidates, assigns with
// compare-and-set and reports tasks with nobody eligible. Bounded to 25 tasks per run.
export async function assignQueueAutomatically(organizationId: string): Promise<QueueResult> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  if (!access.can("tasks.assign")) return { error: "Only owners and admins assign tasks." };
  if ((await getAssignmentMode(access.organization.id)) !== "AUTO") return { error: "Automatic assignment is not enabled for this organization." };
  const queue = (await listOpenOrganizationTasks(access.organization.id)).filter((t) => t.assigneeId === null && t.status === "TODO").slice(0, 25);
  if (queue.length === 0) return { success: "The assignment queue is empty." };
  let assigned = 0;
  const skipped: string[] = [];
  for (const task of queue) {
    const result = await autoAssignTask(task.ids);
    if (result.success) assigned++;
    else skipped.push(`${task.title}: ${result.error ?? "not assigned"}`);
  }
  const detail = skipped.length ? ` Not assigned: ${skipped.slice(0, 5).join(" · ")}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""}.` : "";
  return { success: `Assigned ${assigned} of ${queue.length} task${queue.length === 1 ? "" : "s"} automatically.${detail}`.slice(0, 900) };
}
