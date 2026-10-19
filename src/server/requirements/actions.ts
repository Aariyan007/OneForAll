"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE, toErrorMessage } from "./errors";
import {
  type WorkItemActionResult,
  type WorkItemFormState,
  isAllowedRequirementTransition,
  requirementStatusSchema,
  workItemFieldsSchema,
} from "./schema";

// Every action verifies the session server-side, validates input, then lets the database
// (RLS, constraints and the lifecycle trigger) decide. Ids from the browser are only targets,
// never proof of authority, and created_by is derived from auth.uid() inside the RPC.

const projectIdsSchema = z.object({
  organizationId: idSchema,
  departmentId: idSchema,
  teamId: idSchema,
  projectId: idSchema,
});
const requirementIdsSchema = projectIdsSchema.extend({ requirementId: idSchema });

function requirementsPath(ids: z.infer<typeof projectIdsSchema>) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects/${ids.projectId}/requirements`;
}

function formFields(formData: FormData) {
  return workItemFieldsSchema.safeParse({
    title: formData.get("title"),
    description: formData.get("description") ?? "",
    priority: formData.get("priority"),
  });
}

export async function createRequirement(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  _prev: WorkItemFormState,
  formData: FormData,
): Promise<WorkItemFormState> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  const fields = formFields(formData);
  if (!ids.success) return { error: "Invalid project." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  // New requirements are always DRAFT; the RPC and the insert policy both enforce it.
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_requirement", {
    p_project_id: ids.data.projectId,
    p_title: fields.data.title,
    p_description: fields.data.description ?? undefined,
    p_priority: fields.data.priority,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: requirementsPath(ids.data) };
}

export async function updateRequirement(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  _prev: WorkItemFormState,
  formData: FormData,
): Promise<WorkItemFormState> {
  await requireUser();

  const ids = requirementIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId });
  const fields = formFields(formData);
  if (!ids.success) return { error: "Invalid requirement." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("requirements")
    .update(fields.data)
    .eq("id", ids.data.requirementId)
    .eq("project_id", ids.data.projectId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  // RLS hides rows the caller cannot update, so zero rows means not found or not permitted.
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(requirementsPath(ids.data));
  return {};
}

export async function updateRequirementStatus(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
  status: string,
): Promise<WorkItemActionResult> {
  await requireUser();

  const ids = requirementIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId });
  const next = requirementStatusSchema.safeParse(status);
  if (!ids.success) return { error: "Invalid requirement." };
  if (!next.success) return { error: "Invalid status." };

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("requirements")
    .select("status")
    .eq("id", ids.data.requirementId)
    .eq("project_id", ids.data.projectId)
    .maybeSingle();
  if (readError) return { error: toErrorMessage(readError) };
  if (!current) return { error: PERMISSION_MESSAGE };

  const from = requirementStatusSchema.safeParse(current.status);
  if (!from.success) return { error: GENERIC_MESSAGE };
  if (from.data === next.data) return {};
  if (!isAllowedRequirementTransition(from.data, next.data)) {
    return { error: `A ${from.data} requirement cannot move to ${next.data}.` };
  }

  // `.eq("status", from)` makes the change a compare-and-set, so a concurrent change is not overwritten.
  const { data, error } = await supabase
    .from("requirements")
    .update({ status: next.data })
    .eq("id", ids.data.requirementId)
    .eq("project_id", ids.data.projectId)
    .eq("status", from.data)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  // No revalidatePath: RequirementStatusActions reloads the page (see src/components/ui/reload.ts).
  return {};
}

export async function deleteRequirement(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  requirementId: string,
): Promise<WorkItemActionResult> {
  await requireUser();

  const ids = requirementIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId, requirementId });
  if (!ids.success) return { error: "Invalid requirement." };

  // Tasks are removed by ON DELETE CASCADE.
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("requirements")
    .delete()
    .eq("id", ids.data.requirementId)
    .eq("project_id", ids.data.projectId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(requirementsPath(ids.data));
  return {};
}
