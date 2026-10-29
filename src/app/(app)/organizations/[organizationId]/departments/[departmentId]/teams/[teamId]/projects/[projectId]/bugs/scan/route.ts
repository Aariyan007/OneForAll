import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { aiConfigured } from "@/server/ai/service";
import { getCurrentUser } from "@/server/auth/session";
import { cancelScan, createScan, getScan, latestScan, resumeScan, stepScan } from "@/server/bugs/service";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { loadProjectGraph } from "@/server/repository-graph/project";
import { getGraphAccess } from "@/server/repository-graph/queries";

// Whole-project bug scan of one snapshot (OWNER/ADMIN only).
//   GET  ?snapshotId=…                          the newest scan of the snapshot (progress)
//   POST {snapshotId, op:"start"}               plan the files and create the scan
//   POST {snapshotId, op:"step", scanId}        run pending batches (up to ~4.5 minutes), return progress; call again to continue
//   POST {snapshotId, op:"resume"|"cancel", scanId}
// Same origin -> session -> body -> organization..snapshot chain (RLS) -> role; the database re-checks the role.

export const maxDuration = 300;

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("start"), snapshotId: z.uuid(), force: z.boolean().optional() }).strict(),
  z.object({ op: z.enum(["step", "resume", "cancel"]), snapshotId: z.uuid(), scanId: z.uuid() }).strict(),
]);

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/bugs/scan">;

function publicScan(scan: Awaited<ReturnType<typeof latestScan>>) {
  if (!scan) return null;
  const { plan, ...rest } = scan;
  const info = plan as { unchangedFiles?: number; unchangedTokensSaved?: number };
  return { ...rest, unchangedFiles: info.unchangedFiles ?? 0, unchangedTokensSaved: info.unchangedTokensSaved ?? 0 };
}

export async function GET(request: NextRequest, context: Ctx) {
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const snapshotId = z.uuid().safeParse(request.nextUrl.searchParams.get("snapshotId"));
  if (!snapshotId.success) return json({ error: "Invalid request." }, 400);
  const p = await context.params;
  const access = await getGraphAccess(p.organizationId, p.departmentId, p.teamId, p.projectId, snapshotId.data);
  if (!access) return json({ error: "Not found." }, 404);
  return json({ scan: publicScan(await latestScan(access.snapshot.id)) });
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const body = bodySchema.safeParse(await readSmallJson(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);
  const p = await context.params;
  const access = await getGraphAccess(p.organizationId, p.departmentId, p.teamId, p.projectId, body.data.snapshotId);
  if (!access) return json({ error: "Not found." }, 404);
  const role = access.context.organization.role;
  if (role !== "OWNER" && role !== "ADMIN") return json({ error: "Only organization owners and admins can scan a repository." }, 403);
  if (access.snapshot.status !== "COMPLETED") return json({ error: "Only a completed import can be scanned." }, 409);

  try {
    if (body.data.op === "start") {
      if (!aiConfigured()) return json({ error: "The AI assistant is not configured on this server (GEMINI_API_KEY is missing)." }, 503);
      const loaded = await loadProjectGraph(p.organizationId, p.departmentId, p.teamId, p.projectId, access.snapshot.id);
      if (!loaded) return json({ error: "Not found." }, 404);
      const started = await createScan(access.snapshot.id, loaded.data, { projectId: access.context.project.id, force: body.data.force });
      if (!started.ok) return json({ error: started.error }, started.status);
      return json({ scan: publicScan(await getScan(started.scanId, access.snapshot.id)) });
    }

    const scan = await getScan(body.data.scanId, access.snapshot.id);
    if (!scan) return json({ error: "Not found." }, 404);
    if (body.data.op === "cancel") {
      await cancelScan(scan.id);
    } else if (body.data.op === "resume") {
      const resumed = await resumeScan(scan.id);
      if (!resumed.ok) return json({ error: resumed.error ?? "The scan could not be resumed." }, 409);
    } else if (scan.status === "RUNNING") {
      if (!aiConfigured()) return json({ error: "The AI assistant is not configured on this server (GEMINI_API_KEY is missing)." }, 503);
      await stepScan(scan, access, request.signal);
    }
    return json({ scan: publicScan(await getScan(scan.id, access.snapshot.id)) });
  } catch (error) {
    console.error("[bugs] scan request failed", { op: body.data.op, error });
    return json({ error: "The scan request failed. Try again." }, 500);
  }
}
