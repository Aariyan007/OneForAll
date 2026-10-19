"use server";

import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";

// Marks the caller's own notifications as read (mark_notifications_read() only touches auth.uid()'s rows). No
// revalidatePath: the client reloads the page afterwards (see src/server/members/actions.ts for why).
export async function markNotificationsRead(ids: string[] | null): Promise<{ error?: string }> {
  await requireUser();
  const list = ids === null ? null : z.array(idSchema).max(200).safeParse(ids);
  if (list && !list.success) return { error: "Invalid request." };
  const supabase = await createClient();
  const { error } = await supabase.rpc("mark_notifications_read", { p_ids: (list ? list.data : null) as string[] });
  if (error) return { error: "Could not update notifications." };
  return {};
}
