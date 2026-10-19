"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import {
  type ProjectActionResult,
  type ProjectFormState,
  createProjectSchema,
  isAllowedTransition,
  projectStatusSchema,
  updateProjectSchema,
} from "./schema";

// Every action verifies the session server-side, validates input, then lets the database
// (RLS, constraints and the status trigger) decide. Ids from the browser are only targets,
// never proof of authority.

const PERMISSION_MESSAGE = "You do not have permission to do that.";

function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "23505":
      return "A project with this name already exists in this team.";
    case "23514":
      return error.message.includes("status transition")
        ? "That status change is not allowed."
        : "Some of the submitted values are not valid.";
    default:
      return "Something went wrong. Please try again.";
  }
}

const teamIdsSchema = z.object({ organizationId: idSchema, departmentId: idSchema, teamId: idSchema });
const projectIdsSchema = teamIdsSchema.extend({ projectId: idSchema });

function projectsPath(ids: { organizationId: string; departmentId: string; teamId: string }) {
  return `/organizations/${ids.organizationId}/departments/${ids.departmentId}/teams/${ids.teamId}/projects`;
}

export async function createProject(
  organizationId: string,
  departmentId: string,
  teamId: string,
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  await requireUser();

  const ids = teamIdsSchema.safeParse({ organizationId, departmentId, teamId });
  const fields = createProjectSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
    projectType: formData.get("projectType"),
  });
  if (!ids.success) return { error: "Invalid team." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  // New projects are always DRAFT; the RPC and the insert policy both enforce it.
  const supabase = await createClient();
  const { error } = await supabase.rpc("create_project", {
    p_team_id: ids.data.teamId,
    p_name: fields.data.name,
    p_description: fields.data.description ?? undefined,
    p_project_type: fields.data.projectType,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: projectsPath(ids.data) };
}

export async function updateProject(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  _prev: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  const fields = updateProjectSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!ids.success) return { error: "Invalid project." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .update(fields.data)
    .eq("id", ids.data.projectId)
    .eq("team_id", ids.data.teamId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  // RLS hides rows the caller cannot update, so zero rows means not found or not permitted.
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(projectsPath(ids.data));
  return {};
}

export async function updateProjectStatus(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
  status: string,
): Promise<ProjectActionResult> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  const next = projectStatusSchema.safeParse(status);
  if (!ids.success) return { error: "Invalid project." };
  if (!next.success) return { error: "Invalid status." };

  const supabase = await createClient();
  const { data: current, error: readError } = await supabase
    .from("projects")
    .select("status")
    .eq("id", ids.data.projectId)
    .eq("team_id", ids.data.teamId)
    .maybeSingle();
  if (readError) return { error: toErrorMessage(readError) };
  if (!current) return { error: PERMISSION_MESSAGE };

  const from = projectStatusSchema.safeParse(current.status);
  if (!from.success) return { error: "Something went wrong. Please try again." };
  if (from.data === next.data) return {};
  if (!isAllowedTransition(from.data, next.data)) {
    return { error: `A ${from.data} project cannot move to ${next.data}.` };
  }

  // `.eq("status", from)` makes the change a compare-and-set, so a concurrent change is not overwritten.
  const { data, error } = await supabase
    .from("projects")
    .update({ status: next.data })
    .eq("id", ids.data.projectId)
    .eq("team_id", ids.data.teamId)
    .eq("status", from.data)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(projectsPath(ids.data));
  return {};
}

export async function deleteProject(
  organizationId: string,
  departmentId: string,
  teamId: string,
  projectId: string,
): Promise<ProjectActionResult> {
  await requireUser();

  const ids = projectIdsSchema.safeParse({ organizationId, departmentId, teamId, projectId });
  if (!ids.success) return { error: "Invalid project." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .delete()
    .eq("id", ids.data.projectId)
    .eq("team_id", ids.data.teamId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidatePath(projectsPath(ids.data));
  return {};
}
