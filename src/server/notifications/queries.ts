import "server-only";
import { cache } from "react";
import { createClient } from "@/lib/supabase/server";

// In-app notifications of the signed-in user only (RLS: notifications_select_own). No email or push delivery exists.

export async function listNotifications(limit = 100) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("notifications")
    .select("id, type, title, body, link, created_at, read_at, organization_id")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error("Failed to load notifications.");
  return data;
}

// Due-soon and overdue notifications for the caller's own tasks. There is no scheduler, so this runs once per request
// from the app layout (before the unread count). Idempotent per task and due date; failures are ignored.
export const generateDeadlineNotifications = cache(async (): Promise<void> => {
  const supabase = await createClient();
  await supabase.rpc("generate_deadline_notifications");
});

export const countUnreadNotifications = cache(async () => {
  const supabase = await createClient();
  const { count, error } = await supabase.from("notifications").select("id", { count: "exact", head: true }).is("read_at", null);
  return error ? 0 : (count ?? 0);
});
