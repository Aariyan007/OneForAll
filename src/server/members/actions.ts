"use server";

import { headers } from "next/headers";
import { z } from "zod";
import { ROLE_LABELS, invitableRoles } from "@/lib/authz/permissions";
import { publicEnv } from "@/lib/env";
import { buildInvitationEmail, invitationLink, resolveAppUrl } from "@/lib/members/invitation-email";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { getOrgAccess } from "@/server/authz/access";
import { idSchema } from "@/server/departments/schema";
import { sendEmail } from "@/server/email/mailer";
import { rpcErrorMessage } from "@/server/errors";
import { getProfile } from "@/server/profiles/queries";

// Membership Server Actions. Each one re-verifies the session and the caller's membership of the organization from
// the database (getOrgAccess), validates input, and calls a SECURITY DEFINER function that checks the caller's role
// again inside the database. Ids and roles from the browser are only requests, never proof of authority.
// No revalidatePath here: on this Next.js version (16.2.9) applying the re-rendered page that a revalidating Server
// Action returns was observed to leave the client transition pending on complex pages (the action ran, the UI stayed
// "pending"). Client components reload the page after a successful change instead (see docs/rbac-workforce.md).

export type MemberActionState = {
  error?: string;
  success?: string;
  inviteLink?: string;
  invitedEmail?: string;
  emailDelivery?: "sent" | "not-configured" | "failed";
};

const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,100}$/);

export async function inviteMember(organizationId: string, _prev: MemberActionState, formData: FormData): Promise<MemberActionState> {
  const access = await getOrgAccess(organizationId);
  if (!access) return { error: "Organization not found." };
  const parsed = z
    .object({ email: z.string().trim().toLowerCase().email("Enter a valid email address.").max(320), role: z.enum(["ADMIN", "MEMBER"]) })
    .safeParse({ email: formData.get("email"), role: formData.get("role") });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Invalid invitation." };
  if (!invitableRoles(access.role).includes(parsed.data.role)) return { error: "You cannot invite someone with that role." };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("create_organization_invitation", {
    p_organization_id: access.organization.id,
    p_email: parsed.data.email,
    p_role: parsed.data.role,
  });
  const created = data?.[0];
  if (error || !created) return { error: rpcErrorMessage(error, "The invitation could not be created.") };

  const appUrl = resolveAppUrl({ appUrl: process.env.APP_URL, origin: (await headers()).get("origin"), siteUrl: publicEnv.NEXT_PUBLIC_SITE_URL });
  const inviteLink = invitationLink(appUrl, created.token);
  const inviter = await getProfile(access.user.id).catch(() => null);
  const delivery = await sendEmail(
    parsed.data.email,
    buildInvitationEmail({
      organizationName: access.organization.name,
      inviterName: inviter?.display_name?.trim() || inviter?.email || "A teammate",
      roleLabel: ROLE_LABELS[parsed.data.role],
      link: inviteLink,
      expiresAt: created.expires_at,
    }),
  );
  // The link is still returned (shown once) so the inviter can resend it by hand if the email does not arrive.
  return {
    success: delivery.sent ? `Invitation emailed to ${parsed.data.email}.` : `Invitation created for ${parsed.data.email}.`,
    invitedEmail: parsed.data.email,
    inviteLink,
    emailDelivery: delivery.sent ? "sent" : delivery.reason,
  };
}

export async function revokeInvitation(organizationId: string, invitationId: string): Promise<MemberActionState> {
  const access = await getOrgAccess(organizationId);
  if (!access || !idSchema.safeParse(invitationId).success) return { error: "Invitation not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("revoke_organization_invitation", { p_invitation_id: invitationId });
  if (error) return { error: rpcErrorMessage(error, "The invitation could not be revoked.") };
  return { success: "Invitation revoked." };
}

export async function changeMemberRole(organizationId: string, memberId: string, role: string): Promise<MemberActionState> {
  const access = await getOrgAccess(organizationId);
  const next = z.enum(["ADMIN", "MEMBER"]).safeParse(role);
  if (!access || !idSchema.safeParse(memberId).success) return { error: "Member not found." };
  if (!next.success) return { error: "Choose Admin or Employee." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("change_member_role", { p_member_id: memberId, p_role: next.data });
  if (error) return { error: rpcErrorMessage(error, "The role could not be changed.") };
  return { success: "Role updated." };
}

export async function setMemberSuspended(organizationId: string, memberId: string, suspended: boolean): Promise<MemberActionState> {
  const access = await getOrgAccess(organizationId);
  if (!access || !idSchema.safeParse(memberId).success) return { error: "Member not found." };
  if (!access.can("members.suspend")) return { error: "Only owners and admins can suspend members." };
  const supabase = await createClient();
  const { error } = await supabase.rpc(suspended ? "suspend_organization_member" : "reactivate_organization_member", { p_member_id: memberId });
  if (error) return { error: rpcErrorMessage(error, suspended ? "The member could not be suspended." : "The member could not be reactivated.") };
  return { success: suspended ? "Member suspended." : "Member reactivated." };
}

export async function removeMember(organizationId: string, memberId: string): Promise<MemberActionState> {
  const access = await getOrgAccess(organizationId);
  if (!access || !idSchema.safeParse(memberId).success) return { error: "Member not found." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("remove_organization_member", { p_member_id: memberId });
  if (error) return { error: rpcErrorMessage(error, "The member could not be removed.") };
  return { success: "Member removed." };
}

export type InvitationPreview =
  | { ok: true; organizationName: string; role: string; status: string; expiresAt: string; emailHint: string; emailMatches: boolean }
  | { ok: false; error: string };

export async function previewInvitation(token: string): Promise<InvitationPreview> {
  await requireUser();
  if (!tokenSchema.safeParse(token).success) return { ok: false, error: "This invitation link is not valid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_invitation_preview", { p_token: token });
  const row = data?.[0];
  if (error || !row) return { ok: false, error: "This invitation link is not valid." };
  return {
    ok: true,
    organizationName: row.organization_name,
    role: row.role,
    status: row.status,
    expiresAt: row.expires_at,
    emailHint: row.email_hint,
    emailMatches: row.email_matches,
  };
}

export async function acceptInvitation(token: string): Promise<{ ok: true; organizationId: string } | { ok: false; error: string }> {
  await requireUser();
  if (!tokenSchema.safeParse(token).success) return { ok: false, error: "This invitation link is not valid." };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("accept_organization_invitation", { p_token: token });
  if (error || !data) return { ok: false, error: rpcErrorMessage(error, "The invitation could not be accepted.") };
  return { ok: true, organizationId: data };
}
