"use server";

import { z } from "zod";
import { automaticChoice } from "@/lib/workforce/assignment";
import { DEFECT_SEVERITIES, TASK_STATUSES } from "@/lib/tasks/workflow";
import { createClient } from "@/lib/supabase/server";
import { idSchema } from "@/server/departments/schema";
import { rpcErrorMessage } from "@/server/errors";
import { getProjectContext } from "@/server/requirements/queries";
import { getAssignmentMode } from "@/server/workforce/queries";
import { getAssignmentRanking } from "./assignment";
import { getTaskContext } from "./detail";

// Task workflow Server Actions. Each re-verifies the whole chain organization -> ... -> task from the database
// (getTaskContext; RLS applies) and then calls a SECURITY DEFINER function that checks the caller's authority itself
// (manager, assignee, receiving team). Ids, roles and assignees from the browser are only requests.
// No revalidatePath here: on this Next.js version (16.2.9) applying the re-rendered page that a revalidating Server
// Action returns was observed to leave the client transition pending on complex pages (the action ran, the UI stayed
// "pending"). Client components reload the page after a successful change instead (see docs/rbac-workforce.md).

export type TaskIds = { organizationId: string; departmentId: string; teamId: string; projectId: string; requirementId: string; taskId: string };
export type TaskActionState = { error?: string; success?: string };

const taskIdsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
  requirementId: idSchema,
  taskId: idSchema,
});

async function resolve(ids: TaskIds) {
  if (!taskIdsSchema.safeParse(ids).success) return null;
  return getTaskContext(ids);
}


export async function assignTask(ids: TaskIds, assigneeId: string, expectedAssigneeId: string, mode: string, reason: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const assignee = assigneeId === "" ? null : idSchema.safeParse(assigneeId).success ? assigneeId : undefined;
  const expected = expectedAssigneeId === "" ? null : idSchema.safeParse(expectedAssigneeId).success ? expectedAssigneeId : undefined;
  const m = z.enum(["MANUAL", "RECOMMENDED"]).safeParse(mode);
  if (assignee === undefined || expected === undefined || !m.success) return { error: "Invalid assignment." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_task", {
    p_task_id: context.task.id,
    // SQL NULL = unassign / "nobody was assigned"; the generated types do not express SQL NULL for these parameters.
    p_assignee: assignee as string,
    p_expected_assignee: expected as string,
    p_mode: m.data,
    p_reason: reason.trim().slice(0, 500) || undefined,
  });
  if (error) return { error: rpcErrorMessage(error, "The task could not be assigned.") };
  return { success: assignee ? "Assigned." : "Unassigned." };
}

// Automatic assignment (organization policy AUTO only): the top-ranked eligible person, compare-and-set on the
// current (empty) assignment so a concurrent assignment wins and nothing is overwritten.
export async function autoAssignTask(ids: TaskIds): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  if (context.task.assignee_id) return { error: "The task is already assigned." };
  if ((await getAssignmentMode(context.organization.id)) !== "AUTO") return { error: "Automatic assignment is not enabled for this organization." };
  const result = await getAssignmentRanking(context.task, { automatic: true });
  if (!result) return { error: "You do not have permission to do that." };
  const choice = automaticChoice(result.ranking);
  if (choice.userId === null) {
    // Leave it unassigned and tell the other owners/admins (once per task per day); the caller sees the reason.
    const supabase = await createClient();
    await supabase.rpc("report_unassignable_task", { p_task_id: context.task.id, p_reason: choice.reason.slice(0, 500) });
    return { error: choice.reason };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("assign_task", {
    p_task_id: context.task.id,
    p_assignee: choice.userId,
    p_expected_assignee: null as unknown as string,
    p_mode: "AUTO",
    p_reason: choice.reasons.join(" ").slice(0, 500),
  });
  if (error) return { error: rpcErrorMessage(error, "The task could not be assigned.") };
  return { success: "Assigned automatically." };
}

export async function transitionTask(ids: TaskIds, status: string, reason: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const next = z.enum(TASK_STATUSES).safeParse(status);
  if (!next.success) return { error: "Invalid status." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("transition_task", { p_task_id: context.task.id, p_status: next.data, p_reason: reason.trim().slice(0, 1000) || undefined });
  if (error) return { error: rpcErrorMessage(error, "The status could not be changed.") };
  return { success: "Status updated." };
}

const planningSchema = z.object({
  acceptanceCriteria: z.string().trim().max(4000, "Acceptance criteria: at most 4000 characters."),
  estimatedHours: z.union([z.literal(""), z.coerce.number().positive("The estimate must be positive.").max(1000, "At most 1000 hours.")]),
  dueDate: z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.")]),
  qaRequired: z.boolean(),
});

export async function updateTaskPlanning(ids: TaskIds, _prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const parsed = planningSchema.safeParse({
    acceptanceCriteria: formData.get("acceptanceCriteria") ?? "",
    estimatedHours: formData.get("estimatedHours") ?? "",
    dueDate: formData.get("dueDate") ?? "",
    qaRequired: formData.get("qaRequired") === "on",
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid values." };
  const supabase = await createClient();
  // tasks_update_admin (RLS) limits this to OWNER/ADMIN; column grants limit it to the planning fields.
  const { data, error } = await supabase
    .from("tasks")
    .update({
      acceptance_criteria: parsed.data.acceptanceCriteria || null,
      estimated_hours: parsed.data.estimatedHours === "" ? null : Math.round(parsed.data.estimatedHours * 10) / 10,
      due_date: parsed.data.dueDate || null,
      qa_required: parsed.data.qaRequired,
    })
    .eq("id", context.task.id)
    .select("id");
  if (error) return { error: rpcErrorMessage(error, "The task could not be saved.") };
  if (data.length === 0) return { error: "You do not have permission to do that." };
  return { success: "Saved." };
}

export async function setTaskRequiredSkills(ids: TaskIds, skillIds: string[]): Promise<TaskActionState> {
  const context = await resolve(ids);
  const list = z.array(idSchema).max(20).safeParse(skillIds);
  if (!context || !list.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_task_required_skills", { p_task_id: context.task.id, p_skill_ids: list.data });
  if (error) return { error: rpcErrorMessage(error, "The skills could not be saved.") };
  return { success: "Required skills saved." };
}

export async function addTaskDependency(ids: TaskIds, dependsOnId: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context || !idSchema.safeParse(dependsOnId).success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_task_dependency", { p_task_id: context.task.id, p_depends_on: dependsOnId });
  if (error) return { error: rpcErrorMessage(error, "The dependency could not be added.") };
  return { success: "Dependency added." };
}

export async function removeTaskDependency(ids: TaskIds, dependsOnId: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context || !idSchema.safeParse(dependsOnId).success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_task_dependency", { p_task_id: context.task.id, p_depends_on: dependsOnId });
  if (error) return { error: rpcErrorMessage(error, "The dependency could not be removed.") };
  return { success: "Dependency removed." };
}

export async function addTaskComment(ids: TaskIds, _prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const body = z.string().trim().min(1, "Write a comment.").max(4000, "At most 4000 characters.").safeParse(formData.get("body"));
  if (!body.success) return { error: body.error.issues[0]?.message };
  // Mentioned people: ids only; the database checks that each one can see the task.
  const mentions = z.array(idSchema).max(10, "Mention at most 10 people.").safeParse([...new Set(formData.getAll("mentions"))]);
  if (!mentions.success) return { error: mentions.error.issues[0]?.message ?? "Invalid mentions." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_task_comment", { p_task_id: context.task.id, p_body: body.data, p_mentions: mentions.data });
  if (error) return { error: rpcErrorMessage(error, "The comment could not be added.") };
  return { success: "Comment added." };
}

export async function declineTaskAssignment(ids: TaskIds, reason: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const text = reason.trim().slice(0, 500);
  if (!text) return { error: "Say why you decline the task." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("decline_task_assignment", { p_task_id: context.task.id, p_reason: text });
  if (error) return { error: rpcErrorMessage(error, "The task could not be declined.") };
  return { success: "Declined. The task is back in the assignment queue." };
}

const defectSchema = z.object({
  title: z.string().trim().min(1, "Give the defect a title.").max(200, "Title: at most 200 characters."),
  details: z.string().trim().max(4000, "Details: at most 4000 characters."),
  severity: z.enum(DEFECT_SEVERITIES),
});

export async function reportTaskDefect(ids: TaskIds, _prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const parsed = defectSchema.safeParse({ title: formData.get("title") ?? "", details: formData.get("details") ?? "", severity: formData.get("severity") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid defect." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("report_task_defect", {
    p_task_id: context.task.id,
    p_title: parsed.data.title,
    p_details: parsed.data.details,
    p_severity: parsed.data.severity,
  });
  if (error) return { error: rpcErrorMessage(error, "The defect could not be reported.") };
  return { success: "Defect reported. The task is back in progress for the assignee." };
}

export async function resolveTaskDefect(ids: TaskIds, defectId: string, resolution: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context || !idSchema.safeParse(defectId).success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("resolve_task_defect", { p_defect_id: defectId, p_resolution: resolution.trim().slice(0, 2000) });
  if (error) return { error: rpcErrorMessage(error, "The defect could not be resolved.") };
  return { success: "Defect resolved." };
}

const linkSchema = z.object({
  url: z
    .string()
    .trim()
    .max(500, "At most 500 characters.")
    .refine((value) => {
      try {
        const url = new URL(value);
        return url.protocol === "https:" && Boolean(url.hostname) && !/[\s<>"]/.test(value);
      } catch {
        return false;
      }
    }, "Use a full https:// address."),
  label: z.string().trim().max(120, "Label: at most 120 characters."),
});

export async function addTaskLink(ids: TaskIds, _prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const parsed = linkSchema.safeParse({ url: formData.get("url") ?? "", label: formData.get("label") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid link." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("add_task_link", { p_task_id: context.task.id, p_url: parsed.data.url, p_label: parsed.data.label });
  if (error) return { error: rpcErrorMessage(error, "The link could not be added.") };
  return { success: "Link added." };
}

export async function removeTaskLink(ids: TaskIds, linkId: string): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context || !idSchema.safeParse(linkId).success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_task_link", { p_link_id: linkId });
  if (error) return { error: rpcErrorMessage(error, "The link could not be removed.") };
  return { success: "Link removed." };
}

export async function createTaskHandoff(ids: TaskIds, _prev: TaskActionState, formData: FormData): Promise<TaskActionState> {
  const context = await resolve(ids);
  if (!context) return { error: "Task not found." };
  const parsed = z
    .object({
      toTeam: idSchema,
      summary: z.string().trim().min(1, "Describe the work completed.").max(4000),
      remaining: z.string().trim().max(4000),
      notes: z.string().trim().max(4000),
    })
    .safeParse({ toTeam: formData.get("toTeam"), summary: formData.get("summary") ?? "", remaining: formData.get("remaining") ?? "", notes: formData.get("notes") ?? "" });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid handoff." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_task_handoff", {
    p_task_id: context.task.id,
    p_to_team_id: parsed.data.toTeam,
    p_summary: parsed.data.summary,
    p_remaining: parsed.data.remaining,
    p_notes: parsed.data.notes,
  });
  if (error) return { error: rpcErrorMessage(error, "The handoff could not be created.") };
  return { success: "Handoff sent to the team." };
}

export async function respondTaskHandoff(ids: TaskIds, handoffId: string, decision: string, note: string, take: boolean): Promise<TaskActionState> {
  const context = await resolve(ids);
  const d = z.enum(["accept", "decline", "cancel"]).safeParse(decision);
  if (!context || !idSchema.safeParse(handoffId).success || !d.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("respond_task_handoff", {
    p_handoff_id: handoffId,
    // NULL cancels; the generated type does not express SQL NULL for this parameter.
    p_accept: (d.data === "cancel" ? null : d.data === "accept") as boolean,
    p_note: note.trim().slice(0, 2000),
    p_take: take,
  });
  if (error) return { error: rpcErrorMessage(error, "The handoff could not be updated.") };
  return { success: d.data === "accept" ? "Handoff accepted." : d.data === "decline" ? "Handoff declined." : "Handoff cancelled." };
}

const projectIdsSchema = z.object({ organizationId: idSchema, departmentId: idSchema, teamId: idSchema, projectId: idSchema });
type ProjectIds = z.infer<typeof projectIdsSchema>;

export async function setProjectTeam(ids: ProjectIds, teamId: string, add: boolean): Promise<TaskActionState> {
  if (!projectIdsSchema.safeParse(ids).success || !idSchema.safeParse(teamId).success) return { error: "Invalid request." };
  const context = await getProjectContext(ids.organizationId, ids.departmentId, ids.teamId, ids.projectId);
  if (!context) return { error: "Project not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc(add ? "add_project_team" : "remove_project_team", { p_project_id: context.project.id, p_team_id: teamId });
  if (error) return { error: rpcErrorMessage(error, "The team could not be updated.") };
  return { success: add ? "Team added to the project." : "Team removed from the project." };
}
