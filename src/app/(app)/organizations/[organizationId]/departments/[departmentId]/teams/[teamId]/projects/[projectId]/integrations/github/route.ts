import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/server/auth/session";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { getIntegrationContext, integrationsPath } from "@/server/integrations/context";
import { importGitHubCommit, listGitHubBranches, listGitHubRepositories, resolveGitHubCommit } from "@/server/integrations/service";
import { revalidatePath } from "next/cache";

// GitHub source import for one project (JSON):
//   GET  ?op=branches | ?op=repositories
//   POST { op: "resolve", branch, commit? }   preview: branch (+ optional SHA) -> exact commit, no writes
//   POST { op: "import", branch, sha }        fetch exactly that commit from GitHub and ingest it
// Every request re-verifies the session and the project chain, and requires a caller who can manage the project
// (the database re-checks OWNER/ADMIN on every write). POST requires the same origin (CSRF). The repository is always
// the project's connected repository; no URL is accepted from the client.

export const maxDuration = 120;

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

const postSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("resolve"), branch: z.string().max(255), commit: z.string().max(64).optional().default("") }),
  z.object({ op: z.literal("import"), branch: z.string().max(255), sha: z.string().regex(/^[0-9a-f]{40}$/) }),
]);

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/integrations/github">;

async function target(context: Ctx) {
  const params = await context.params;
  const integration = await getIntegrationContext(params.organizationId, params.departmentId, params.teamId, params.projectId);
  return integration && integration.canManage ? { params, integration } : null;
}

export async function GET(request: NextRequest, context: Ctx) {
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const t = await target(context);
  if (!t) return json({ error: "Not found." }, 404);
  const op = request.nextUrl.searchParams.get("op");
  if (op === "branches") return json(await listGitHubBranches(t.integration.project.id, t.integration.repository));
  if (op === "repositories") return json(await listGitHubRepositories(t.integration.project.id));
  return json({ error: "Invalid request." }, 400);
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const parsed = postSchema.safeParse(await readSmallJson(request));
  if (!parsed.success) return json({ error: "Invalid request." }, 400);
  const t = await target(context);
  if (!t) return json({ error: "Not found." }, 404);
  const { project, repository } = t.integration;

  try {
    if (parsed.data.op === "resolve") {
      return json(await resolveGitHubCommit(project.id, repository, parsed.data.branch, parsed.data.commit));
    }
    if (!repository) return json({ ok: false, error: "Connect a GitHub repository to this project first." });
    const result = await importGitHubCommit(project.id, repository, parsed.data.branch, parsed.data.sha);
    const projectPath = integrationsPath(t.params).replace(/\/integrations$/, "");
    revalidatePath(projectPath);
    revalidatePath(`${projectPath}/repository/snapshots`);
    revalidatePath(integrationsPath(t.params));
    return json(result);
  } catch (error) {
    // Never log tokens, headers or archive contents: only the operation and project.
    console.error("[integrations/github] request failed", { op: parsed.data.op, projectId: project.id, error: error instanceof Error ? error.message : "unknown" });
    return json({ ok: false, error: "The GitHub request failed. Try again." }, 500);
  }
}
