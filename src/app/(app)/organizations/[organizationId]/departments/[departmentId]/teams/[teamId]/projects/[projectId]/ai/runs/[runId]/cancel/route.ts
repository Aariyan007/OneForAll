import { NextResponse, type NextRequest } from "next/server";
import { requestCancel } from "@/server/ai/service";
import { getCurrentUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { isSameOrigin } from "@/server/http/request-guards";

// Asks a running AI run to stop. The database allows the requester or an organization OWNER/ADMIN; the running
// request checks the flag between steps and ends the run as cancelled.

const HEADERS = { "Cache-Control": "private, no-store" };

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/ai/runs/[runId]/cancel">;

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403, headers: HEADERS });
  if (!(await getCurrentUser())) return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: HEADERS });
  const { runId } = await context.params;
  if (!idSchema.safeParse(runId).success || !(await requestCancel(runId))) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: HEADERS });
  }
  return NextResponse.json({ ok: true }, { headers: HEADERS });
}
