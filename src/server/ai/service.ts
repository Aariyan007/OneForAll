import "server-only";
import { createClient } from "@/lib/supabase/server";
import type { Json } from "@/types/database";
import { JOBS } from "./jobs";
import { modelRegistry } from "./models";
import { type RunEvent, type RunOutcome, runJob } from "./orchestrator";
import { createGeminiProvider } from "./provider/gemini";
import { createGroqProvider, createOpenRouterProvider } from "./provider/hosted";
import type { LlmProvider } from "./provider/types";
import { PROCESS_COOLDOWNS } from "./routing";
import { createRunStore, createSnapshotReader } from "./supabase";
import { checkSyntax } from "./syntax";
import type { JobType, ProviderId } from "./types";

// Starts and runs one AI job for the signed-in user. INTERNAL and server-only (not a Server Action): the caller has
// verified the session and the project chain, and passes the project and snapshot ids it resolved from the database.
// start_ai_run re-checks visibility, the snapshot state, the organization switch and quotas in the database.

export type StartResult =
  | { ok: true; runId: string; correlationId: string }
  | { ok: false; status: number; error: string };

export function aiConfigured(): boolean {
  return modelRegistry(process.env).configured;
}

// Which providers this server can use, by name only: never keys, never model ids with secrets. For the page's notices.
export function configuredProviders(): ProviderId[] {
  const registry = modelRegistry(process.env);
  return (Object.keys(registry.providers) as ProviderId[]).filter((id) => registry.providers[id].configured);
}

// One adapter per CONFIGURED provider, built from the server's environment on each run. The router only offers candidates
// whose adapter exists, so an unconfigured provider is skipped, never called.
function createProviders(registry: ReturnType<typeof modelRegistry>): Partial<Record<ProviderId, LlmProvider>> {
  const providers: Partial<Record<ProviderId, LlmProvider>> = {};
  if (registry.providers.gemini.configured) providers.gemini = createGeminiProvider(registry.providers.gemini.apiKey!);
  if (registry.providers.groq.configured) providers.groq = createGroqProvider(registry.providers.groq.apiKey!);
  if (registry.providers.openrouter.configured) providers.openrouter = createOpenRouterProvider(registry.providers.openrouter.apiKey!);
  return providers;
}

export async function startRun(snapshotId: string, job: JobType, input: unknown): Promise<StartResult> {
  if (!aiConfigured()) return { ok: false, status: 503, error: "The AI assistant is not configured on this server (set GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY)." };
  const parsed = JOBS[job].inputSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: `The request is not valid: ${parsed.error.issues[0]?.message ?? "invalid input"}.` };
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("start_ai_run", { p_snapshot_id: snapshotId, p_job_type: job, p_input: parsed.data as Json });
  if (error) {
    if (error.code === "54000") return { ok: false, status: 429, error: error.message };
    if (error.code === "55000") return { ok: false, status: 409, error: error.message };
    if (error.code === "22023") return { ok: false, status: 400, error: "The request is not valid." };
    return { ok: false, status: 404, error: "Not found." };
  }
  const row = data[0];
  return row ? { ok: true, runId: row.run_id, correlationId: row.correlation_id } : { ok: false, status: 500, error: "The run could not be started." };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function executeRun(
  run: { runId: string; correlationId: string; projectId: string; snapshotId: string; job: JobType; input: unknown },
  signal: AbortSignal,
  onEvent: (event: RunEvent) => void,
): Promise<RunOutcome> {
  const registry = modelRegistry(process.env);
  const store = await createRunStore(run.runId);
  const outcome = await runJob(
    {
      providers: createProviders(registry),
      cooldowns: PROCESS_COOLDOWNS,
      registry,
      reader: await createSnapshotReader(run.snapshotId, run.projectId),
      store,
      now: Date.now,
      sleep,
      syntaxCheck: checkSyntax,
      onEvent,
    },
    run.job,
    run.input,
    { signal },
  );
  try {
    await store.finish(outcome);
  } catch {
    // The stale-run sweep closes it later; the user still gets the outcome below.
    console.error(JSON.stringify({ event: "ai_run_finish_failed", correlationId: run.correlationId }));
  }
  // One structured line per run: identifiers and metrics only, never prompts, code or answers.
  console.info(
    JSON.stringify({
      event: "ai_run",
      correlationId: run.correlationId,
      runId: run.runId,
      job: run.job,
      status: outcome.status,
      errorCategory: outcome.error?.category ?? null,
      tier: outcome.tier ?? null,
      provider: outcome.provider ?? null,
      model: outcome.model ?? null,
      category: outcome.category ?? null,
      route: outcome.attemptLog.map((a) => `${a.provider}:${a.outcome}`),
      usageReported: outcome.usageReported,
      turns: outcome.turns,
      toolCalls: outcome.toolCalls,
      attempts: outcome.attempts,
      fallback: outcome.fallback,
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      contextTokensEstimate: outcome.contextTokensEstimate,
      durationMs: outcome.durationMs,
    }),
  );
  return outcome;
}

export async function requestCancel(runId: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("request_ai_run_cancel", { p_run_id: runId });
  return !error;
}
