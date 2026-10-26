import { createClient } from "@supabase/supabase-js";
import { publicEnv } from "@/lib/env";
import { healthReport } from "@/lib/health";
import type { Database } from "@/types/database";

// Public liveness check (see src/lib/public-paths.ts): app up, and Postgres reachable through PostgREST. Uses an
// anonymous client without the visitor's session and a function that reads no table; answers only up/down.
export const dynamic = "force-dynamic";

const DATABASE_TIMEOUT_MS = 3000;

export async function GET() {
  const supabase = createClient<Database>(publicEnv.NEXT_PUBLIC_SUPABASE_URL, publicEnv.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  let database = false;
  try {
    const { data, error } = await supabase.rpc("health_check").abortSignal(AbortSignal.timeout(DATABASE_TIMEOUT_MS));
    database = !error && data === true;
  } catch {
    database = false;
  }
  const report = healthReport({ database, checkedAt: new Date().toISOString() });
  return Response.json(report.body, { status: report.httpStatus, headers: { "Cache-Control": "no-store" } });
}
