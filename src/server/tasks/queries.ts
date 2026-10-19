import "server-only";
import { createClient } from "@/lib/supabase/server";

// RLS returns tasks only when the parent requirement (and therefore its project) is visible.
export async function listTasks(requirementId: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("tasks")
    .select("id, title, status, priority, assignee_id, due_date")
    .eq("requirement_id", requirementId)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to load tasks: ${error.message}`);
  const names = await profileNames(data.map((t) => t.assignee_id));
  return data.map((t) => ({ ...t, assigneeName: t.assignee_id ? (names.get(t.assignee_id) ?? "Member") : null }));
}

// Display names of users the caller may see (co-members; RLS hides everyone else).
export async function profileNames(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const supabase = await createClient();
  const { data } = await supabase.from("profiles").select("id, display_name, email").in("id", unique);
  return new Map((data ?? []).map((p) => [p.id, p.display_name || p.email]));
}
