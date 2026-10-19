"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import {
  type DepartmentActionResult,
  type DepartmentFormState,
  departmentFieldsSchema,
  idSchema,
} from "./schema";

// Every action verifies the session server-side, validates input, then lets the database
// (RLS) decide. Ids from the browser are only targets, never proof of authority.

function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return "You do not have permission to do that.";
    case "23505":
      return error.message.includes("name already exists")
        ? "A department with this name already exists."
        : "That user is already a member of this department.";
    default:
      return "Something went wrong. Please try again.";
  }
}

function revalidateDepartments(organizationId: string) {
  revalidatePath(`/organizations/${organizationId}/departments`);
}

export async function createDepartment(
  organizationId: string,
  _prev: DepartmentFormState,
  formData: FormData,
): Promise<DepartmentFormState> {
  await requireUser();

  const orgId = idSchema.safeParse(organizationId);
  const fields = departmentFieldsSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!orgId.success) return { error: "Invalid organization." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_department", {
    p_organization_id: orgId.data,
    p_name: fields.data.name,
    p_description: fields.data.description ?? undefined,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: `/organizations/${orgId.data}/departments` };
}

export async function updateDepartment(
  organizationId: string,
  departmentId: string,
  _prev: DepartmentFormState,
  formData: FormData,
): Promise<DepartmentFormState> {
  await requireUser();

  const ids = z.object({ organizationId: idSchema, departmentId: idSchema }).safeParse({ organizationId, departmentId });
  const fields = departmentFieldsSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!ids.success) return { error: "Invalid department." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .update(fields.data)
    .eq("id", ids.data.departmentId)
    .eq("organization_id", ids.data.organizationId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  // RLS hides rows the caller cannot update, so zero rows means not found or not permitted.
  if (data.length === 0) return { error: "You do not have permission to do that." };

  revalidateDepartments(ids.data.organizationId);
  return {};
}

export async function deleteDepartment(organizationId: string, departmentId: string): Promise<DepartmentActionResult> {
  await requireUser();

  const ids = z.object({ organizationId: idSchema, departmentId: idSchema }).safeParse({ organizationId, departmentId });
  if (!ids.success) return { error: "Invalid department." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("departments")
    .delete()
    .eq("id", ids.data.departmentId)
    .eq("organization_id", ids.data.organizationId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: "You do not have permission to do that." };

  revalidateDepartments(ids.data.organizationId);
  return {};
}

export async function addDepartmentMember(
  organizationId: string,
  departmentId: string,
  userId: string,
): Promise<DepartmentActionResult> {
  await requireUser();

  const ids = z
    .object({ organizationId: idSchema, departmentId: idSchema, userId: idSchema })
    .safeParse({ organizationId, departmentId, userId });
  if (!ids.success) return { error: "Invalid request." };

  // RLS requires the caller to be OWNER/ADMIN of the department's organization
  // and the target user to belong to that same organization.
  const supabase = await createClient();
  const { error } = await supabase
    .from("department_members")
    .insert({ department_id: ids.data.departmentId, user_id: ids.data.userId });
  if (error) return { error: toErrorMessage(error) };

  revalidateDepartments(ids.data.organizationId);
  return {};
}

export async function removeDepartmentMember(
  organizationId: string,
  departmentId: string,
  userId: string,
): Promise<DepartmentActionResult> {
  await requireUser();

  const ids = z
    .object({ organizationId: idSchema, departmentId: idSchema, userId: idSchema })
    .safeParse({ organizationId, departmentId, userId });
  if (!ids.success) return { error: "Invalid request." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("department_members")
    .delete()
    .eq("department_id", ids.data.departmentId)
    .eq("user_id", ids.data.userId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: "You do not have permission to do that." };

  revalidateDepartments(ids.data.organizationId);
  return {};
}
