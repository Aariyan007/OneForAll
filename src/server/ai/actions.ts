"use server";

import { createClient } from "@/lib/supabase/server";
import { getOrgAccess } from "@/server/authz/access";
import { rpcErrorMessage } from "@/server/errors";

// Organization-wide AI switch. The caller's role is checked here for an early answer; set_ai_enabled() re-checks
// OWNER/ADMIN in the database and records the change in the audit log.

export type AiSettingResult = { error?: string; success?: string };

export async function setAiEnabled(organizationId: string, enabled: boolean): Promise<AiSettingResult> {
  const access = await getOrgAccess(organizationId);
  if (!access || typeof enabled !== "boolean") return { error: "Invalid request." };
  if (access.role !== "OWNER" && access.role !== "ADMIN") return { error: "Only owners and admins can change this setting." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_ai_enabled", { p_organization_id: access.organization.id, p_enabled: enabled });
  if (error) return { error: rpcErrorMessage(error, "The setting could not be saved.") };
  return { success: enabled ? "AI assistant turned on." : "AI assistant turned off." };
}
