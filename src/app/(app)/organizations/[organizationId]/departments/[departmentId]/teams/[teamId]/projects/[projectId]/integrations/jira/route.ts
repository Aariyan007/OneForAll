import { revalidatePath } from "next/cache";
import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { getIntegrationContext, integrationsPath } from "@/server/integrations/context";
import { listJiraProjects, syncJira } from "@/server/integrations/service";

// Jira Cloud import for one project (JSON):
//   GET  ?op=projects          Jira projects visible to the connected account
//   POST { op: "sync" }        one-way import of the selected Jira project's issues (Jira -> OneForAll)
// Every request re-verifies the session and the project chain and requires a caller who can manage the project; the
// database re-checks OWNER/ADMIN on every write. POST requires the same origin (CSRF).

export const maxDuration = 120;

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/integrations/jira">;

async function target(context: Ctx) {
  const params = await context.params;
  const integration = await getIntegrationContext(params.organizationId, params.departmentId, params.teamId, params.projectId);
  return integration && integration.canManage ? { params, integration } : null;
}

export async function GET(request: NextRequest, context: Ctx) {
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const t = await target(context);
  if (!t) return json({ error: "Not found." }, 404);
  if (request.nextUrl.searchParams.get("op") !== "projects") return json({ error: "Invalid request." }, 400);
  return json(await listJiraProjects(t.integration.project.id));
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const body = await readSmallJson(request);
  if (!body || typeof body !== "object" || (body as { op?: unknown }).op !== "sync") return json({ error: "Invalid request." }, 400);
  const t = await target(context);
  if (!t) return json({ error: "Not found." }, 404);
  try {
    const result = await syncJira(t.integration.project.id);
    revalidatePath(integrationsPath(t.params));
    return json(result);
  } catch (error) {
    console.error("[integrations/jira] sync failed", { projectId: t.integration.project.id, error: error instanceof Error ? error.message : "unknown" });
    return json({ ok: false, error: "The Jira sync failed. Try again." }, 500);
  }
}
