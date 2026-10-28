import "server-only";
import { z } from "zod";
import { BUG_CATEGORIES, BUG_SEVERITIES, BUG_STATUSES, OPEN_BUG_STATUSES, SEVERITY_RANK, type BugSeverity } from "@/lib/bugs/model";
import { createClient } from "@/lib/supabase/server";
import { getMyRepository } from "@/server/repositories/queries";
import { getProjectContext } from "@/server/requirements/queries";
import { aiConfigured } from "@/server/ai/service";
import { latestScan, type ScanRow } from "./service";

// Everything the Bugs page shows, read as the signed-in user: RLS limits it to the projects they can see. Null for
// anything not permitted (the page turns it into a 404).

export const bugFiltersSchema = z.object({
  status: z.enum(BUG_STATUSES).optional(),
  severity: z.enum(BUG_SEVERITIES).optional(),
  category: z.enum(BUG_CATEGORIES).optional(),
  assignee: z.union([z.literal("me"), z.literal("none"), z.uuid()]).optional(),
  open: z.literal("1").optional(),
  q: z.string().trim().max(100).optional(),
});
export type BugFilters = z.infer<typeof bugFiltersSchema>;

export function parseBugFilters(query: Record<string, string | string[] | undefined>): BugFilters {
  const flat = Object.fromEntries(Object.entries(query).map(([k, v]) => [k, typeof v === "string" && v !== "" ? v : undefined]));
  const parsed = bugFiltersSchema.safeParse(flat);
  return parsed.success ? parsed.data : {};
}

export type BugListItem = {
  id: string;
  title: string;
  filePath: string;
  startLine: number;
  category: string;
  severity: BugSeverity;
  status: string;
  confidence: number;
  assignedTo: string | null;
  assigneeName: string | null;
  createdAt: string;
};

const LIST_LIMIT = 300;
const COUNT_LIMIT = 5000;

export async function getBugsPage(organizationId: string, departmentId: string, teamId: string, projectId: string, filters: BugFilters) {
  const context = await getProjectContext(organizationId, departmentId, teamId, projectId);
  if (!context) return null;
  const supabase = await createClient();
  const { data: auth } = await supabase.auth.getUser();
  const userId = auth.user?.id ?? null;
  const repository = await getMyRepository(context.project.id);
  const canManage = context.organization.role === "OWNER" || context.organization.role === "ADMIN";

  const { data: snapshotRow } = repository
    ? await supabase.from("repository_snapshots").select("id, commit_sha, branch, completed_at").eq("repository_id", repository.id).eq("status", "COMPLETED").order("completed_at", { ascending: false }).limit(1).maybeSingle()
    : { data: null };
  const scan: ScanRow | null = snapshotRow ? await latestScan(snapshotRow.id) : null;

  const { data: all } = await supabase.from("repository_bugs").select("severity, status, assigned_to, category").eq("project_id", context.project.id).limit(COUNT_LIMIT);
  const counts = { total: 0, open: 0, unassigned: 0, bySeverity: {} as Record<string, number>, byStatus: {} as Record<string, number>, mine: 0 };
  for (const row of all ?? []) {
    counts.total++;
    counts.byStatus[row.status] = (counts.byStatus[row.status] ?? 0) + 1;
    const open = (OPEN_BUG_STATUSES as readonly string[]).includes(row.status);
    if (open) {
      counts.open++;
      counts.bySeverity[row.severity] = (counts.bySeverity[row.severity] ?? 0) + 1;
      if (!row.assigned_to) counts.unassigned++;
    }
    if (open && userId && row.assigned_to === userId) counts.mine++;
  }

  let query = supabase
    .from("repository_bugs")
    .select("id, title, file_path, start_line, category, severity, status, confidence, assigned_to, created_at")
    .eq("project_id", context.project.id);
  if (filters.status) query = query.eq("status", filters.status);
  if (filters.severity) query = query.eq("severity", filters.severity);
  if (filters.category) query = query.eq("category", filters.category);
  if (filters.open) query = query.in("status", OPEN_BUG_STATUSES as string[]);
  if (filters.assignee === "me" && userId) query = query.eq("assigned_to", userId);
  else if (filters.assignee === "none") query = query.is("assigned_to", null);
  else if (filters.assignee && filters.assignee !== "me") query = query.eq("assigned_to", filters.assignee);
  if (filters.q) {
    const term = filters.q.replace(/[%_,()]/g, " ");
    query = query.or(`title.ilike.%${term}%,file_path.ilike.%${term}%`);
  }
  const { data: rows, error } = await query.order("created_at", { ascending: false }).limit(LIST_LIMIT);
  if (error) throw new Error("Failed to load the bugs.");

  const assigneeIds = [...new Set((rows ?? []).map((r) => r.assigned_to).filter((id): id is string => !!id))];
  const names = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const { data: profiles } = await supabase.from("profiles").select("id, display_name, email").in("id", assigneeIds);
    for (const p of profiles ?? []) names.set(p.id, p.display_name?.trim() || p.email || "Someone");
  }
  const bugs: BugListItem[] = (rows ?? [])
    .map((r) => ({
      id: r.id,
      title: r.title,
      filePath: r.file_path,
      startLine: r.start_line,
      category: r.category,
      severity: r.severity as BugSeverity,
      status: r.status,
      confidence: Number(r.confidence),
      assignedTo: r.assigned_to,
      assigneeName: r.assigned_to ? (names.get(r.assigned_to) ?? "Someone") : null,
      createdAt: r.created_at,
    }))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.confidence - a.confidence);

  return { ...context, repository, snapshot: snapshotRow, scan, counts, bugs, canManage, userId, aiConfigured: aiConfigured(), truncated: (rows?.length ?? 0) >= LIST_LIMIT };
}
