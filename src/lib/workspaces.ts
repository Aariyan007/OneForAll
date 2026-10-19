import "server-only";
import { listMyOrganizations } from "@/server/organizations/queries";

export type Workspace = { id: string; name: string; slug: string; role: string };

// The organizations the user belongs to and the user's own role in each (one row per membership of this user).
export async function listMyWorkspaces(userId: string): Promise<Workspace[]> {
  const rows = await listMyOrganizations(userId);
  return rows.map(({ id, name, slug, role }) => ({ id, name, slug, role }));
}
