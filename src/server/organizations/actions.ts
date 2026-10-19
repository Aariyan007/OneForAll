"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { type CreateOrganizationState, createOrganizationSchema } from "./schema";

export async function createOrganization(
  _prev: CreateOrganizationState,
  formData: FormData,
): Promise<CreateOrganizationState> {
  // Verified server-side. No user id or role is ever read from the form.
  await requireUser();

  const parsed = createOrganizationSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { fieldErrors: z.flattenError(parsed.error).fieldErrors };
  }

  // The RPC derives the owner from auth.uid() and creates organization + OWNER membership atomically.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization", { p_name: parsed.data.name });

  const created = data?.[0];
  if (error || !created) {
    return { error: "Could not create the organization. Please try again." };
  }

  // No revalidatePath: CreateOrganizationForm opens the new organization with a full page load instead
  // (see src/components/ui/reload.ts).
  return { organization: created };
}

// Rename (owners and admins: organizations_update_admin RLS and the column grant on name decide).
export async function renameOrganization(organizationId: string, _prev: { error?: string; success?: string }, formData: FormData): Promise<{ error?: string; success?: string }> {
  await requireUser();
  if (!idSchema.safeParse(organizationId).success) return { error: "Organization not found." };
  const name = z.string().trim().min(1, "Enter a name.").max(100, "At most 100 characters.").safeParse(formData.get("name"));
  if (!name.success) return { error: name.error.issues[0]?.message };
  const supabase = await createClient();
  const { data, error } = await supabase.from("organizations").update({ name: name.data }).eq("id", organizationId).select("id");
  if (error) return { error: "The name could not be saved." };
  if (data.length === 0) return { error: "Only owners and admins can rename the organization." };
  return { success: "Organization renamed." };
}
