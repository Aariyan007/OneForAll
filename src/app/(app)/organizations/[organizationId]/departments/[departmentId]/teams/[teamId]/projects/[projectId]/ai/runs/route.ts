import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { JOB_TYPES } from "@/server/ai/types";
import { executeRun, startRun } from "@/server/ai/service";
import { getCurrentUser } from "@/server/auth/session";
import { isSameOrigin, readSmallJson } from "@/server/http/request-guards";
import { getRepositoryContext } from "@/server/repository-snapshots/queries";
import { createClient } from "@/lib/supabase/server";

// Starts one AI run on a snapshot of this project's repository and streams its progress as NDJSON:
//   POST { snapshotId, job, input }  ->  {"type":"started",...}  {"type":"event",...}*  {"type":"result",...}
// Order: same origin (CSRF) -> session -> body -> project chain -> snapshot of THIS repository -> start_ai_run (the
// database re-checks visibility, snapshot state, the organization switch and quotas). Closing the connection cancels
// the run. Stream lines carry states, tool names and metrics only; the answer comes once, validated, in "result".

export const maxDuration = 120;

const HEADERS = { "Cache-Control": "private, no-store" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: HEADERS });

const bodySchema = z.object({ snapshotId: z.uuid(), job: z.enum(JOB_TYPES), input: z.record(z.string(), z.unknown()) }).strict();

type Ctx = RouteContext<"/organizations/[organizationId]/departments/[departmentId]/teams/[teamId]/projects/[projectId]/ai/runs">;

export async function POST(request: NextRequest, context: Ctx) {
  if (!isSameOrigin(request)) return json({ error: "Cross-origin requests are not allowed." }, 403);
  if (!(await getCurrentUser())) return json({ error: "Sign in first." }, 401);
  const body = bodySchema.safeParse(await readSmallJson(request));
  if (!body.success) return json({ error: "Invalid request." }, 400);

  const params = await context.params;
  const repo = await getRepositoryContext(params.organizationId, params.departmentId, params.teamId, params.projectId);
  if (!repo) return json({ error: "Not found." }, 404);
  const supabase = await createClient();
  const { data: snapshot } = await supabase
    .from("repository_snapshots")
    .select("id")
    .eq("id", body.data.snapshotId)
    .eq("repository_id", repo.repository.id)
    .maybeSingle();
  if (!snapshot) return json({ error: "Not found." }, 404);

  const started = await startRun(snapshot.id, body.data.job, body.data.input);
  if (!started.ok) return json({ error: started.error }, started.status);

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: unknown) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
        } catch {
          // The client went away; the run is cancelled through the request signal.
        }
      };
      send({ type: "started", runId: started.runId, correlationId: started.correlationId });
      const outcome = await executeRun(
        { ...started, projectId: repo.project.id, snapshotId: snapshot.id, job: body.data.job, input: body.data.input },
        request.signal,
        (event) => send({ type: "event", event }),
      );
      send({
        type: "result",
        runId: started.runId,
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        metrics: {
          tier: outcome.tier ?? null,
          provider: outcome.provider ?? null,
          model: outcome.model ?? null,
          category: outcome.category ?? null,
          usageReported: outcome.usageReported,
          costKnown: outcome.costKnown,
          baselineTokensEstimate: outcome.baselineTokensEstimate > 0 ? outcome.baselineTokensEstimate : null,
          techniques: outcome.techniques,
          attemptLog: outcome.attemptLog,
          usage: outcome.usage,
          costUsd: outcome.costUsd,
          turns: outcome.turns,
          toolCalls: outcome.toolCalls,
          attempts: outcome.attempts,
          fallback: outcome.fallback,
          citationsDropped: outcome.citationsDropped,
          contextTokensEstimate: outcome.contextTokensEstimate,
          contextOmitted: outcome.contextOmitted,
          syntaxValid: outcome.syntaxValid ?? null,
          durationMs: outcome.durationMs,
        },
      });
      try {
        controller.close();
      } catch {
        // already closed by a disconnect
      }
    },
  });
  return new Response(stream, { headers: { ...HEADERS, "Content-Type": "application/x-ndjson; charset=utf-8" } });
}
