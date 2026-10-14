import { NextResponse, type NextRequest } from "next/server";
import { getCurrentUser } from "@/server/auth/session";
import { PERMISSION_MESSAGE } from "@/server/requirements/errors";
import { ingestSnapshotArchive } from "@/server/repository-sources/ingestion";
import { BODY_LIMITS } from "@/server/repository-sources/limits";
import { resolveSnapshotTarget, revalidateSnapshotPages, snapshotPath } from "@/server/repository-sources/target";

// Source-archive upload for one snapshot. A Route Handler instead of a Server Action so that file bytes never travel
// through the Server Action protocol (which keeps its default 1 MB body limit for every other action).
//
// Security, in order: same-origin check (CSRF; Server Actions get this from Next.js, a Route Handler must do it
// itself), declared body size checked before the body is read, authenticated user, every id in the URL re-verified
// from the database under RLS, then the ingestion service (which re-validates the upload and lets the database decide
// every write). The response never contains internal details.
//
// Clients that ask for JSON (the upload form) get { ok, error | message, warning? }. A plain form post (no
// JavaScript) is redirected back to the snapshot page, which shows the recorded outcome.

export const maxDuration = 120;

type UploadResponse = { ok: boolean; error?: string; message?: string; warning?: string; changed?: boolean };

function wantsJson(request: NextRequest) {
  return (request.headers.get("accept") ?? "").includes("application/json");
}

function isSameOrigin(request: NextRequest) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest, context: RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/repository/snapshots/[snapshotId]/source">) {
  const json = wantsJson(request);
  const fail = (status: number, error: string) => NextResponse.json<UploadResponse>({ ok: false, error }, { status });

  if (!isSameOrigin(request)) return fail(403, "Cross-origin uploads are not allowed.");

  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared)) return fail(411, "The upload must declare its size.");
  if (Number(declared) > BODY_LIMITS.uploadRequestBodyBytes) {
    return fail(413, "The archive is too large. Choose a smaller archive and try again.");
  }

  const user = await getCurrentUser();
  if (!user) return fail(401, "Sign in to upload source code.");

  const target = await resolveSnapshotTarget(await context.params);
  if (!target) return fail(403, PERMISSION_MESSAGE);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return fail(400, "The upload could not be read. Choose the archive again and retry.");
  }

  const result = await ingestSnapshotArchive(target.repositoryId, target.ids.snapshotId, formData.get("archive"));
  const changed = result.ok || result.changed === true;
  if (changed) revalidateSnapshotPages(target.ids);

  if (!json) {
    const url = new URL(snapshotPath(target.ids), request.url);
    if (!result.ok && !changed) url.searchParams.set("upload", "rejected");
    return NextResponse.redirect(url, 303);
  }
  if (!result.ok) {
    // A failure after processing started was recorded (200, changed). Anything else wrote nothing: a snapshot outside
    // the verified repository is refused like any other target the caller cannot manage (403), an invalid upload is 422.
    const status = changed ? 200 : result.error === PERMISSION_MESSAGE ? 403 : 422;
    return NextResponse.json<UploadResponse>({ ok: false, error: result.error, changed }, { status });
  }
  return NextResponse.json<UploadResponse>({ ok: true, message: result.message, warning: result.analysisError, changed: true });
}
