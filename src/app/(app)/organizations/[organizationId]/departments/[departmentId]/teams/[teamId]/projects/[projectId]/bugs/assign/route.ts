import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/server/auth/session";
import { assign, autoAssign, recommendFor, unassign } from "@/server/bugs/assignment";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { createClient } from "@/lib/supabase/server";
import { getProjectContext } from "@/server/requirements/queries";

// Bug assignment for one project (OWNER/ADMIN; the database enforces it and decides who is eligible).
//   GET  ?bugId=…                               eligible people ranked for that bug, with reasons
//   POST {op:"assign", bugId, userId, reason?}  manual assignment
//   POST {op:"unassign", bugId, reason?}
//   POST {op:"auto", bugIds?}                   assign unassigned open bugs to the best eligible people
// Same origin -> session -> project chain (RLS) -> database function.

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("assign"), bugId: z.uuid(), userId: z.uuid(), reason: z.string().trim().max(500).optional() }).strict(),
  z.object({ op: z.literal("unassign"), bugId: z.uuid(), reason: z.string().trim().max(500).optional() }).strict(),
  z.object({ op: z.literal("auto"), bugIds: z.array(z.uuid()).max(100).optional() }).strict(),
]);

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/bugs/assign">;

export async function GET(request: NextRequest, context: Ctx) {
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const bugId = z.uuid().safeParse(request.nextUrl.searchParams.get("bugId"));
  if (!bugId.success) return json({ error: "Invalid request." }, 400);
  const p = await context.params;
  const project = await getProjectContext(p.organizationId, p.departmentId, p.teamId, p.projectId);
  if (!project) return json({ error: "Not found." }, 404);
  const supabase = await createClient();
  const { data: bug } = await supabase.from("repository_bugs").select("category, severity, file_path").eq("id", bugId.data).eq("project_id", project.project.id).maybeSingle();
  if (!bug) return json({ error: "Not found." }, 404);
  const recommendations = await recommendFor(project.project.id, { category: bug.category, severity: bug.severity, filePath: bug.file_path });
  if (!recommendations) return json({ error: "Only organization owners and admins can assign bugs." }, 403);
  return json({ recommendations });
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const body = bodySchema.safeParse(await readSmallJson(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);
  const p = await context.params;
  const project = await getProjectContext(p.organizationId, p.departmentId, p.teamId, p.projectId);
  if (!project) return json({ error: "Not found." }, 404);
  const supabase = await createClient();

  try {
    if (body.data.op === "auto") {
      const summary = await autoAssign(project.project.id, body.data.bugIds);
      return summary ? json(summary) : json({ error: "Only organization owners and admins can assign bugs." }, 403);
    }
    // The bug must belong to THIS project; the database function re-checks everything else.
    const { data: bug } = await supabase.from("repository_bugs").select("id").eq("id", body.data.bugId).eq("project_id", project.project.id).maybeSingle();
    if (!bug) return json({ error: "Not found." }, 404);
    const result =
      body.data.op === "assign"
        ? await assign(bug.id, body.data.userId, "MANUAL", body.data.reason || "Assigned by an admin.")
        : await unassign(bug.id, body.data.reason ?? "");
    return result.ok ? json({ ok: true }) : json({ error: result.error }, result.status);
  } catch (error) {
    console.error("[bugs] assignment failed", { op: body.data.op, error });
    return json({ error: "The request failed. Try again." }, 500);
  }
}
