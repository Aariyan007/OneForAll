import "server-only";
import { cache } from "react";
import { type Capability, type OrgRole, can, isOrgRole } from "@/lib/authz/permissions";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { getMyOrganization } from "@/server/organizations/queries";

// The caller's access to one organization, resolved from the database on every request (never from the URL, a form
// field or client state): the verified user, their membership row and its role. Returns null when the id is malformed
// or the caller is not a member, so callers 404 without revealing whether the organization exists.
// Cached per request: layouts and pages share one lookup.
export const getOrgAccess = cache(async (organizationId: string) => {
  if (!idSchema.safeParse(organizationId).success) return null;
  const user = await requireUser();
  const organization = await getMyOrganization(organizationId, user.id);
  if (!organization || !isOrgRole(organization.role)) return null;
  const role: OrgRole = organization.role;
  return {
    user,
    organization,
    role,
    can: (capability: Capability) => can(role, capability),
  };
});

export type OrgAccess = NonNullable<Awaited<ReturnType<typeof getOrgAccess>>>;
