import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getCurrentUser } from "@/server/auth/session";
import { isSameOrigin } from "@/server/http/request-guards";
import { getGraphAccess } from "@/server/repository-graph/queries";
import { loadFileSymbols, searchProjectSymbols } from "@/server/repository-graph/project";
import { rebuildFileEdges } from "@/server/repository-sources/file-edges";

// Lazy pieces of the whole-project graph: GET ?op=symbols&fileId=…, ?op=search&q=…; POST {op:"rebuild"} recomputes the
// snapshot's file-to-file import links from the stored source (OWNER/ADMIN only, enforced by the database).
// Every request re-verifies the session and the organization -> … -> snapshot chain (RLS applies); missing, malformed
// and not-permitted targets give the same 404. Responses are private and never cached.

const getSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("symbols"), fileId: z.uuid() }),
  z.object({ op: z.literal("search"), q: z.string().trim().min(1).max(200) }),
]);

const HEADERS = { "Cache-Control": "private, no-store" };
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: HEADERS });
type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/project-graph/data">;

export async function GET(request: NextRequest, context: Ctx) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in to view the project graph." }, { status: 401, headers: HEADERS });
  const parsed = getSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: HEADERS });

  const { organizationId, departmentId, teamId, projectId, snapshotId } = await context.params;
  try {
    const access = await getGraphAccess(organizationId, departmentId, teamId, projectId, snapshotId);
    if (!access) return notFound();
    if (parsed.data.op === "search") return NextResponse.json({ results: await searchProjectSymbols(access, parsed.data.q) }, { headers: HEADERS });
    return NextResponse.json({ symbols: await loadFileSymbols(access, parsed.data.fileId) }, { headers: HEADERS });
  } catch (error) {
    console.error("[project-graph] data request failed", { snapshotId, error });
    return NextResponse.json({ error: "The graph data could not be loaded. Try again." }, { status: 500, headers: HEADERS });
  }
}

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return NextResponse.json({ error: "Cross-origin requests are not allowed." }, { status: 403, headers: HEADERS });
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: HEADERS });
  const { organizationId, departmentId, teamId, projectId, snapshotId } = await context.params;
  try {
    const access = await getGraphAccess(organizationId, departmentId, teamId, projectId, snapshotId);
    if (!access) return notFound();
    if (access.snapshot.status !== "COMPLETED") return NextResponse.json({ error: "The import is not completed." }, { status: 409, headers: HEADERS });
    const summary = await rebuildFileEdges(access.snapshot.id);
    if (!summary) return NextResponse.json({ error: "Only organization owners and admins can rebuild links." }, { status: 403, headers: HEADERS });
    return NextResponse.json(summary, { headers: HEADERS });
  } catch (error) {
    console.error("[project-graph] rebuild failed", { snapshotId, error });
    return NextResponse.json({ error: "The links could not be rebuilt. Try again." }, { status: 500, headers: HEADERS });
  }
}
