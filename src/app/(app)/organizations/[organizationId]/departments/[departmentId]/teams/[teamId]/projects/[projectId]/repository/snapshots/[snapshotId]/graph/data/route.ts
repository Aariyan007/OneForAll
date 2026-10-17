import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { SEARCH_MAX_QUERY } from "@/lib/repository-graph/explore";
import { getCurrentUser } from "@/server/auth/session";
import { completedAccess, getGraphAccess, loadFilePiece, loadNeighbourPiece, searchSymbols } from "@/server/repository-graph/queries";

// Read-only, bounded pieces of one snapshot's completed structure analysis, for exploring analyses too large to send
// whole: GET ?op=file&fileId=…, ?op=neighbours&symbolId=…, ?op=search&q=…
//
// Every request re-verifies the session and the organization -> … -> snapshot -> COMPLETED analysis chain from the
// database (RLS applies), and every result is limited server-side (see src/lib/repository-graph/explore.ts). Missing,
// malformed and not-permitted targets all give the same 404. Responses are private and never cached.

const opSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("file"), fileId: z.uuid() }),
  z.object({ op: z.literal("neighbours"), symbolId: z.uuid() }),
  z.object({ op: z.literal("search"), q: z.string().trim().min(1).max(SEARCH_MAX_QUERY) }),
]);

const HEADERS = { "Cache-Control": "private, no-store" };
const notFound = () => NextResponse.json({ error: "Not found." }, { status: 404, headers: HEADERS });

export async function GET(
  request: NextRequest,
  context: RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/graph/data">,
) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Sign in to view the repository graph." }, { status: 401, headers: HEADERS });

  const parsed = opSchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: HEADERS });

  const { organizationId, departmentId, teamId, projectId, snapshotId } = await context.params;
  try {
    const access = completedAccess(await getGraphAccess(organizationId, departmentId, teamId, projectId, snapshotId));
    if (!access) return notFound();

    const request_ = parsed.data;
    if (request_.op === "search") return NextResponse.json(await searchSymbols(access, request_.q), { headers: HEADERS });
    const piece = request_.op === "file" ? await loadFilePiece(access, request_.fileId) : await loadNeighbourPiece(access, request_.symbolId);
    return piece ? NextResponse.json(piece, { headers: HEADERS }) : notFound();
  } catch (error) {
    // Logged with its context for operators; the response never contains internal details.
    console.error("[repository-graph] data request failed", { op: parsed.data.op, snapshotId, error });
    return NextResponse.json({ error: "The graph data could not be loaded. Try again." }, { status: 500, headers: HEADERS });
  }
}
