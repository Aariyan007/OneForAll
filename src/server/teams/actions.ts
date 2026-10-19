"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { type TeamActionResult, type TeamFormState, teamFieldsSchema } from "./schema";

// Every action verifies the session server-side, validates input, then lets the database
// (RLS) decide. Ids from the browser are only targets, never proof of authority.

const PERMISSION_MESSAGE = "You do not have permission to do that.";

function toErrorMessage(error: { code?: string; message: string }): string {
  switch (error.code) {
    case "42501":
      return PERMISSION_MESSAGE;
    case "23505":
      return error.message.includes("name already exists")
        ? "A team with this name already exists in this department."
        : "That user is already a member of this team.";
    default:
      return "Something went wrong. Please try again.";
  }
}

const departmentIdsSchema = z.object({ organizationId: idSchema, departmentId: idSchema });
const teamIdsSchema = departmentIdsSchema.extend({ teamId: idSchema });
const teamMemberIdsSchema = teamIdsSchema.extend({ userId: idSchema });

function revalidateTeams(organizationId: string, departmentId: string) {
  revalidatePath(`/organizations/${organizationId}/departments/${departmentId}/teams`);
}

export async function createTeam(
  organizationId: string,
  departmentId: string,
  _prev: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  await requireUser();

  const ids = departmentIdsSchema.safeParse({ organizationId, departmentId });
  const fields = teamFieldsSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!ids.success) return { error: "Invalid department." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { error } = await supabase.rpc("create_team", {
    p_department_id: ids.data.departmentId,
    p_name: fields.data.name,
    p_description: fields.data.description ?? undefined,
  });
  if (error) return { error: toErrorMessage(error) };

  // No redirect(): the form opens this page with a full load (see src/components/ui/reload.ts).
  return { redirectTo: `/organizations/${ids.data.organizationId}/departments/${ids.data.departmentId}/teams` };
}

export async function updateTeam(
  organizationId: string,
  departmentId: string,
  teamId: string,
  _prev: TeamFormState,
  formData: FormData,
): Promise<TeamFormState> {
  await requireUser();

  const ids = teamIdsSchema.safeParse({ organizationId, departmentId, teamId });
  const fields = teamFieldsSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") ?? "",
  });
  if (!ids.success) return { error: "Invalid team." };
  if (!fields.success) return { fieldErrors: z.flattenError(fields.error).fieldErrors };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("teams")
    .update(fields.data)
    .eq("id", ids.data.teamId)
    .eq("department_id", ids.data.departmentId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  // RLS hides rows the caller cannot update, so zero rows means not found or not permitted.
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidateTeams(ids.data.organizationId, ids.data.departmentId);
  return {};
}

export async function deleteTeam(
  organizationId: string,
  departmentId: string,
  teamId: string,
): Promise<TeamActionResult> {
  await requireUser();

  const ids = teamIdsSchema.safeParse({ organizationId, departmentId, teamId });
  if (!ids.success) return { error: "Invalid team." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("teams")
    .delete()
    .eq("id", ids.data.teamId)
    .eq("department_id", ids.data.departmentId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidateTeams(ids.data.organizationId, ids.data.departmentId);
  return {};
}

export async function addTeamMember(
  organizationId: string,
  departmentId: string,
  teamId: string,
  userId: string,
): Promise<TeamActionResult> {
  await requireUser();

  const ids = teamMemberIdsSchema.safeParse({ organizationId, departmentId, teamId, userId });
  if (!ids.success) return { error: "Invalid request." };

  // RLS requires the caller to be OWNER/ADMIN of the team's organization and the target user
  // to belong to that organization AND to the team's department.
  const supabase = await createClient();
  const { error } = await supabase.from("team_members").insert({ team_id: ids.data.teamId, user_id: ids.data.userId });
  if (error) {
    return {
      error:
        error.code === "42501"
          ? "You do not have permission, or the user is not a member of this department."
          : toErrorMessage(error),
    };
  }

  revalidateTeams(ids.data.organizationId, ids.data.departmentId);
  return {};
}

export async function removeTeamMember(
  organizationId: string,
  departmentId: string,
  teamId: string,
  userId: string,
): Promise<TeamActionResult> {
  await requireUser();

  const ids = teamMemberIdsSchema.safeParse({ organizationId, departmentId, teamId, userId });
  if (!ids.success) return { error: "Invalid request." };

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("team_members")
    .delete()
    .eq("team_id", ids.data.teamId)
    .eq("user_id", ids.data.userId)
    .select("id");
  if (error) return { error: toErrorMessage(error) };
  if (data.length === 0) return { error: PERMISSION_MESSAGE };

  revalidateTeams(ids.data.organizationId, ids.data.departmentId);
  return {};
}
