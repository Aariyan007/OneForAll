import "server-only";
import { createClient } from "@/lib/supabase/server";

// Reads for the Members page. Everything runs with the caller's own client, so RLS decides: members of the
// organization see the member list and co-member profiles; invitations and the audit trail are visible to
// OWNER/ADMIN only (other callers simply get empty lists).

export type MemberRow = {
  id: string;
  userId: string;
  role: string;
  status: string; // ACTIVE | SUSPENDED
  suspendedAt: string | null;
  joinedAt: string;
  name: string;
  email: string;
  jobTitle: string | null;
  department: string | null;
  team: string | null;
};

export async function listMembers(organizationId: string): Promise<MemberRow[]> {
  const supabase = await createClient();
  const { data: members, error } = await supabase
    .from("organization_members")
    .select("id, user_id, role, status, suspended_at, created_at")
    .eq("organization_id", organizationId)
    .order("created_at");
  if (error) throw new Error("Failed to load members.");
  const ids = members.map((m) => m.user_id);
  const [{ data: profiles, error: pErr }, { data: directory, error: dErr }] = await Promise.all([
    supabase.from("profiles").select("id, display_name, email").in("id", ids.length ? ids : ["00000000-0000-0000-0000-000000000000"]),
    supabase
      .from("workforce_profiles")
      .select("user_id, job_title, departments(name), teams(name)")
      .eq("organization_id", organizationId)
      .not("user_id", "is", null),
  ]);
  if (pErr || dErr) throw new Error("Failed to load members.");
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const dirById = new Map(directory.map((d) => [d.user_id, d]));
  return members.map((m) => {
    const p = byId.get(m.user_id);
    const d = dirById.get(m.user_id);
    return {
      id: m.id,
      userId: m.user_id,
      role: m.role,
      status: m.status,
      suspendedAt: m.suspended_at,
      joinedAt: m.created_at,
      name: p?.display_name || p?.email || "Member",
      email: p?.email ?? "",
      jobTitle: d?.job_title ?? null,
      department: d?.departments?.name ?? null,
      team: d?.teams?.name ?? null,
    };
  });
}

export async function listInvitations(organizationId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_invitations")
    .select("id, email, role, status, expires_at, created_at, accepted_at, revoked_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(200);
  if (error) throw new Error("Failed to load invitations.");
  const now = Date.now();
  return data.map((i) => ({ ...i, status: i.status === "PENDING" && Date.parse(i.expires_at) <= now ? "EXPIRED" : i.status }));
}

export async function listAuditEvents(organizationId: string, limit = 50) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organization_audit_events")
    .select("id, action, actor_id, target_user_id, target_email, details, created_at")
    .eq("organization_id", organizationId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Failed to load activity.");
  return data;
}

// Closes expired invitations (EXPIRED status, audit entry, inviter notified). There is no scheduler, so the members and
// overview pages call this for owners and admins. Failures are ignored: the list still marks expired rows itself.
export async function closeExpiredInvitations(organizationId: string): Promise<void> {
  const supabase = await createClient();
  await supabase.rpc("close_expired_invitations", { p_organization_id: organizationId });
}

// The caller's suspended memberships (dashboard explanation). Only the organization name is returned.
export async function listMySuspendedMemberships() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_suspended_memberships");
  if (error) return [];
  return data;
}

// Pending invitations addressed to the signed-in user's email (dashboard). Accepting still needs the link.
export async function listMyInvitations() {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_my_invitations");
  if (error) return [];
  return data;
}
