import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { BUG_STATUSES } from "@/lib/bugs/model";
import { createClient } from "@/lib/supabase/server";
import { getCurrentUser } from "@/server/auth/session";
import { aiConfigured } from "@/server/ai/service";
import { commentOnBug, decideFix, generateFix, transitionBug } from "@/server/bugs/fix";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { getProjectContext } from "@/server/requirements/queries";

// Actions on one bug of a project. Every request: same origin -> session -> body -> project chain (RLS) -> the bug of THIS
// project -> a database function that re-checks who may do it. Nothing is ever written to a git provider.
//   POST {op:"transition", to, note?}   status moves (start work, block, review, QA, resolve, reject ...)
//   POST {op:"comment", body}
//   POST {op:"plan", feedback?}         AI fix plan + patch (up to ~2 minutes), stored for approval
//   POST {op:"decide", fixId, decision, note?}   approve (applies + validates), request changes, reject
//   GET  ?diff=<fixId>                  the stored unified diff as a download

export const maxDuration = 180;

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

const bodySchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("transition"), to: z.enum(BUG_STATUSES), note: z.string().trim().max(1000).optional() }).strict(),
  z.object({ op: z.literal("comment"), body: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ op: z.literal("plan"), feedback: z.string().trim().max(1000).optional() }).strict(),
  z.object({ op: z.literal("decide"), fixId: z.uuid(), decision: z.enum(["APPROVE", "REJECT", "REQUEST_CHANGES"]), note: z.string().trim().max(1000).optional() }).strict(),
]);

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/bugs/[bugId]/actions">;

async function resolve(context: Ctx) {
  const p = await context.params;
  if (!z.uuid().safeParse(p.bugId).success) return null;
  const project = await getProjectContext(p.organizationId, p.departmentId, p.teamId, p.projectId);
  if (!project) return null;
  const supabase = await createClient();
  const { data: bug } = await supabase.from("repository_bugs").select("id, title").eq("id", p.bugId).eq("project_id", project.project.id).maybeSingle();
  return bug ? { project, bug } : null;
}

export async function GET(request: NextRequest, context: Ctx) {
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const fixId = z.uuid().safeParse(request.nextUrl.searchParams.get("diff"));
  if (!fixId.success) return json({ error: "Invalid request." }, 400);
  const target = await resolve(context);
  if (!target) return json({ error: "Not found." }, 404);
  const supabase = await createClient();
  const { data: fix } = await supabase.from("repository_bug_fixes").select("diff, version").eq("id", fixId.data).eq("bug_id", target.bug.id).maybeSingle();
  if (!fix) return json({ error: "Not found." }, 404);
  return new NextResponse(fix.diff, {
    headers: { ...HEADERS, "Content-Type": "text/x-diff; charset=utf-8", "Content-Disposition": `attachment; filename="bug-${target.bug.id.slice(0, 8)}-fix-v${fix.version}.diff"`, "X-Content-Type-Options": "nosniff" },
  });
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const body = bodySchema.safeParse(await readSmallJson(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);
  const target = await resolve(context);
  if (!target) return json({ error: "Not found." }, 404);

  try {
    const data = body.data;
    if (data.op === "transition") {
      const result = await transitionBug(target.bug.id, data.to, data.note ?? "");
      return result.ok ? json({ ok: true }) : json({ error: result.error }, result.status);
    }
    if (data.op === "comment") {
      const result = await commentOnBug(target.bug.id, data.body);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, result.status);
    }
    if (data.op === "plan") {
      if (!aiConfigured()) return json({ error: "The AI assistant is not configured on this server (GEMINI_API_KEY is missing)." }, 503);
      const result = await generateFix(target.bug.id, target.project.project.id, request.signal, data.feedback);
      return result.ok ? json({ ok: true, fixId: result.fixId, version: result.version, confidence: result.confidence }) : json({ error: result.error }, result.status);
    }
    const supabase = await createClient();
    const { data: fix } = await supabase.from("repository_bug_fixes").select("id").eq("id", data.fixId).eq("bug_id", target.bug.id).maybeSingle();
    if (!fix) return json({ error: "Not found." }, 404);
    const result = await decideFix(data.fixId, data.decision, data.note ?? "");
    return result.ok ? json({ ok: true, status: result.status, validationPassed: result.validationPassed }) : json({ error: result.error }, result.status);
  } catch (error) {
    console.error("[bugs] action failed", { op: body.data.op, error });
    return json({ error: "The request failed. Try again." }, 500);
  }
}
