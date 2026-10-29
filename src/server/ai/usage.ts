import "server-only";
import { type UsageRow, type UsageSummary, summarizeUsage } from "@/lib/ai/measure";
import { createClient } from "@/lib/supabase/server";

// The signed-in person's own AI usage for the dashboard, from the persisted runs. Read as that person (RLS), and filtered to
// THEIR runs: owners and admins can read teammates' runs too, which must not leak into a personal total. Only finished runs
// count; a run still working has no final usage yet.

export const USAGE_WINDOW_DAYS = 30;
const MAX_ROWS = 2000;
const FINISHED = ["completed", "failed", "cancelled", "timed_out"];

export type MyAiUsage = { ok: true; summary: UsageSummary; days: number } | { ok: false };

export async function getMyAiUsage(userId: string): Promise<MyAiUsage> {
  const supabase = await createClient();
  const since = new Date(Date.now() - USAGE_WINDOW_DAYS * 864e5).toISOString();
  const { data, error } = await supabase
    .from("ai_runs")
    .select("status, provider, usage_reported, input_tokens, output_tokens, thinking_tokens, baseline_tokens_estimate, context_tokens_estimate, fallback_used, attempts, estimated_cost_usd, cost_known")
    .eq("requested_by", userId)
    .in("status", FINISHED)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(MAX_ROWS);
  if (error) {
    console.error("[ai] usage query failed", error.message);
    return { ok: false };
  }
  const rows: UsageRow[] = data.map((r) => ({ ...r, estimated_cost_usd: Number(r.estimated_cost_usd) }));
  return { ok: true, summary: summarizeUsage(rows), days: USAGE_WINDOW_DAYS };
}
