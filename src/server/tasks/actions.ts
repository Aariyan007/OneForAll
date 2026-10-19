"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE, toErrorMessage } from "@/server/requirements/errors";
import { rpcErrorMessage } from "@/server/errors";
import { type TaskActionResult, type TaskFormState, taskFieldsSchema, taskStatusSchema } from "./schema";

// Every action verifies the session server-side, validates input, then lets the database
// (RLS, constraints and the lifecycle trigger) decide. Ids from the browser are only targets,
// never proof of authority, and created_by is derived from auth.uid() inside the RPC.

const requirementIdsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
  requirementId: idSchema,
});
const taskIdsSchema = requirementIdsSchema.extend({ taskId: idSchema });

function requirementPath(ids: z.infer<typeof requirementIdsSchema>) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/requirements/${ids.requirementId}`;
}

function formFields(formData: FormData) {
  return taskFieldsSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    priority: formData.get("priority"),
  });
}

export async function createTask(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  await requireUser();

  const ids = requirementIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId });
  const fields = formFields(formData);
  if (!ids.success) return { error: "Invalid requirement." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  // A task always belongs to a requirement; new tasks are always TODO (RPC and insert policy enforce it).
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_task", {
    p_requirement_id: ids.data.requirementId,
    p_title: fields.data.title,
    p_description: fields.data.description ?? undefined,
    p_priority: fields.data.priority,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: requirementPath(ids.data) };
}

export async function updateTask(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  taskId: string,
  _prev: TaskFormState,
  formData: FormData,
): Promise<TaskFormState> {
  await requireUser();

  const ids = taskIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId, taskId });
  const fields = formFields(formData);
  if (!ids.success) return { error: "Invalid task." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .update(fields.data)
    .eq("id", ids.data.taskId)
    .eq("requirement_id", ids.data.requirementId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(requirementPath(ids.data));
  return {};
}

export async function updateTaskStatus(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  taskId: string,
  status: string,
  reason = "",
): Promise<TaskActionResult> {
  await requireUser();

  const ids = taskIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId, taskId });
  const next = taskStatusSchema.safeParse(status);
  if (!ids.success) return { error: "Invalid task." };
  if (!next.success) return { error: "Invalid status." };

  // Since migration 20261024000001 status changes go through transition_task(), which checks who may take the step
  // (assignee or OWNER/ADMIN), dependencies and required reasons, and logs the change.
  const supabase = await createClient();
  const { data: task, error: readError } = await supabase
    .from("tasks")
    .select("id")
    .eq("id", ids.data.taskId)
    .eq("requirement_id", ids.data.requirementId)
    .maybeSingle();
  if (readError) return { error: toErrorMessage(readError) };
  if (!task) return { error: PERMISSION_MESSAGE };
  const { error } = await supabase.rpc("transition_task", { p_task_id: task.id, p_status: next.data, p_reason: reason.trim() || undefined });
  if (error) return { error: rpcErrorMessage(error, GENERIC_MESSAGE) };

  revalidatePath(requirementPath(ids.data));
  return {};
}

export async function deleteTask(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  taskId: string,
): Promise<TaskActionResult> {
  await requireUser();

  const ids = taskIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId, taskId });
  if (!ids.success) return { error: "Invalid task." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .delete()
    .eq("id", ids.data.taskId)
    .eq("requirement_id", ids.data.requirementId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(requirementPath(ids.data));
  return {};
}
