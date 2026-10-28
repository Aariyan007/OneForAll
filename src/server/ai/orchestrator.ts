import { z } from "zod";
import { estimateTokens, inputBudget } from "./budget";
import { validateCitations } from "./citations";
import { extractJson, lineCount } from "./context";
import { JOBS, type JobContext, wholeRepositoryBlock } from "./jobs";
import type { ModelRegistry } from "./models";
import { type LlmProvider, type LlmRequest, type LlmResponse, type LlmTurn, LlmError } from "./provider/types";
import { RETRY_POLICY, backoffMillis, isRetryable } from "./retry";
import { chooseTier } from "./router";
import { callSignal } from "./signals";
import { canTransition } from "./state";
import { type RepoReader, isSafeRepoPath, runTool, toolDeclarations } from "./tools";
import { type Citation, type JobType, type ProviderErrorCategory, type RunErrorCategory, type RunState, type Tier, type Usage, ZERO_USAGE, addUsage } from "./types";

// Runs one AI job end to end with explicit, validated state transitions:
//
//   queued -> validating -> retrieving_context -> generating <-> executing_tool -> validating_output -> completed
//                                                     ^------------- one correction turn ----------------|
//   any active state -> failed | cancelled; model work -> timed_out (task deadline)
//
// Policy lives here; provider details live in the provider adapter, data access in the RepoReader (which acts as the
// signed-in user). Nothing here decides authorization: the caller has verified the user, the project and the
// snapshot before calling, and the database enforces it again on every read.

export const ORCHESTRATOR_LIMITS = {
  maxModelTurns: 10,
  maxToolCalls: 8,
  deadlineMs: 120_000,
  // Once this share of the deadline is used, tools are switched off and the model is asked to answer with what it has:
  // a late answer beats a timeout (measured free-tier calls take 16-24 s each).
  answerNowAt: 0.6,
  // Leaves room inside the deadline for one fallback call when a model hangs (measured: overloaded calls hang).
  perCallTimeoutMs: 45_000,
  maxCitationFileReads: 20,
} as const;

export type RunStore = {
  // Persists a state change (and validates it again in the database). Called once per transition, in order.
  transition(state: RunState, detail?: Record<string, unknown>): Promise<void>;
  // True once the user asked to cancel (checked between steps).
  cancelRequested(): Promise<boolean>;
};

export type RunEvent =
  | { type: "state"; state: RunState }
  | { type: "model"; tier: Tier; model: string; ms: number; usage: Usage; attempt: number }
  | { type: "retry"; category: ProviderErrorCategory; delayMs: number }
  | { type: "fallback"; from: Tier; to: Tier }
  | { type: "tool"; name: string; ok: boolean; ms: number };

export type OrchestratorDeps = {
  provider: LlmProvider;
  registry: ModelRegistry;
  reader: RepoReader;
  store: RunStore;
  now(): number;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random?(): number;
  // True/false for a syntax check of generated code, null when the language is not supported.
  syntaxCheck?(language: string, code: string): Promise<boolean | null>;
  onEvent?(event: RunEvent): void;
};

export type RunOutcome = {
  status: "completed" | "failed" | "cancelled" | "timed_out";
  result?: Record<string, unknown>;
  error?: { category: RunErrorCategory; message: string };
  usage: Usage;
  tier?: Tier;
  model?: string;
  costUsd: number;
  turns: number;
  toolCalls: number;
  attempts: number;
  fallback: boolean;
  citationsDropped: number;
  contextTokensEstimate: number;
  contextOmitted: number;
  syntaxValid?: boolean | null;
  durationMs: number;
};

const SAFE_MESSAGES: Record<RunErrorCategory, string> = {
  auth: "The AI provider rejected the API key. An administrator must check GEMINI_API_KEY.",
  quota: "The AI provider's quota is used up. Try again later.",
  rate_limited: "The AI provider is rate limiting requests. Try again in a minute.",
  context_overflow: "The request was too large for the model. Ask about a smaller part of the code.",
  invalid_request: "The AI provider refused the request.",
  unavailable: "The AI model is unavailable right now. Try again later.",
  network: "Could not reach the AI provider.",
  timeout: "The AI provider did not answer in time.",
  safety_blocked: "The AI provider blocked the response.",
  bad_output: "The model did not return a valid answer. Try rephrasing.",
  not_configured: "The AI assistant is not configured on this server (GEMINI_API_KEY is missing).",
  disabled: "The AI assistant is turned off for this organization.",
  invalid_input: "The request is not valid.",
  no_source: "This snapshot has no stored source text. Upload the same archive again on the snapshot page to store it.",
  limit_exceeded: "The assistant needed too many steps and stopped.",
  tool_error: "Reading the repository failed.",
  cancelled: "Cancelled.",
  deadline: "The assistant ran out of time.",
  internal: "Something went wrong. Try again.",
};

class RunFailure extends Error {
  constructor(
    readonly category: RunErrorCategory,
    message?: string,
  ) {
    super(message ?? SAFE_MESSAGES[category]);
  }
}

class Stop extends Error {
  constructor(readonly status: "cancelled" | "timed_out") {
    super(status);
  }
}

export async function runJob(
  deps: OrchestratorDeps,
  jobType: JobType,
  rawInput: unknown,
  // contextMode "naive" (evaluation only): the whole repository in context and no tools, as a measured baseline.
  options: { signal: AbortSignal; deadlineMs?: number; contextMode?: "retrieval" | "naive" },
): Promise<RunOutcome> {
  const job = JOBS[jobType];
  const started = deps.now();
  const deadlineMs = options.deadlineMs ?? ORCHESTRATOR_LIMITS.deadlineMs;
  // Held in an object: TypeScript cannot see the closures below change a plain local.
  const cursor: { state: RunState } = { state: "queued" };
  let usage: Usage = ZERO_USAGE;
  let costUsd = 0;
  let turns = 0;
  let toolCalls = 0;
  let attempts = 0;
  let fallback = false;
  let tier: Tier | undefined;
  let model: string | undefined;
  let contextTokensEstimate = 0;
  let contextOmitted = 0;

  const move = async (next: RunState, detail?: Record<string, unknown>) => {
    if (!canTransition(cursor.state, next)) throw new RunFailure("internal", `Invalid transition ${cursor.state} -> ${next}`);
    cursor.state = next;
    await deps.store.transition(next, detail);
    deps.onEvent?.({ type: "state", state: next });
  };

  // Between steps: user cancellation always; the task deadline once model work has started.
  const checkpoint = async (deadlineApplies: boolean) => {
    if (options.signal.aborted || (await deps.store.cancelRequested())) throw new Stop("cancelled");
    if (deadlineApplies && deps.now() - started > deadlineMs) throw new Stop("timed_out");
  };

  const outcome = (status: RunOutcome["status"], extra: Partial<RunOutcome> = {}): RunOutcome => ({
    status,
    usage,
    tier,
    model,
    costUsd: Math.round(costUsd * 1e6) / 1e6,
    turns,
    toolCalls,
    attempts,
    fallback,
    citationsDropped: 0,
    contextTokensEstimate,
    contextOmitted,
    durationMs: deps.now() - started,
    ...extra,
  });

  try {
    await checkpoint(false);
    await move("validating");
    if (!deps.registry.configured) throw new RunFailure("not_configured");
    const parsed = job.inputSchema.safeParse(rawInput);
    if (!parsed.success) throw new RunFailure("invalid_input", `The request is not valid: ${parsed.error.issues[0]?.message ?? "invalid input"}.`);
    const input = parsed.data;
    const files = await deps.reader.listFiles();
    if (!files.some((f) => f.hasText)) throw new RunFailure("no_source");

    await move("retrieving_context");
    const standard = deps.registry.models.standard;
    const budget = inputBudget({ contextLimit: standard.contextLimit, reservedOutput: job.reservedOutput, jobBudget: job.jobBudgetTokens });
    let context: JobContext;
    try {
      // Each job's input type matches its own spec; the union is bridged here once.
      context = await (job.buildContext as (i: unknown, r: RepoReader, b: number) => Promise<JobContext>)(input, deps.reader, budget);
    } catch (error) {
      throw new RunFailure("invalid_input", error instanceof Error && error.message.length < 200 ? error.message : undefined);
    }
    contextTokensEstimate = estimateTokens(context.text);
    if (options.contextMode === "naive") {
      const whole = await wholeRepositoryBlock(deps.reader);
      context = { ...context, text: `${context.text}\n${whole.text}`, lineCounts: new Map([...context.lineCounts, ...whole.lineCounts]) };
    }
    contextOmitted = context.omitted;
    const lineCounts = new Map(context.lineCounts);
    tier = chooseTier({ job: jobType, promptChars: (job.promptChars as (i: unknown) => number)(input), contextTokens: contextTokensEstimate });
    model = deps.registry.models[tier]?.id;

    const turnsList: LlmTurn[] = [{ role: "user", text: (job.userPrompt as (i: unknown, c: JobContext) => string)(input, context) }];
    const outputJsonSchema = withoutMeta(z.toJSONSchema(job.outputSchema) as Record<string, unknown>);
    let toolsEnabled = options.contextMode !== "naive";
    let correctionUsed = false;
    let syntaxFixUsed = false;
    let forceSchema = false;

    for (;;) {
      if (turns >= ORCHESTRATOR_LIMITS.maxModelTurns) throw new RunFailure("limit_exceeded");
      await checkpoint(true);
      if (toolsEnabled && turns > 0 && deps.now() - started > deadlineMs * ORCHESTRATOR_LIMITS.answerNowAt) {
        toolsEnabled = false;
        turnsList.push({ role: "user", text: "Time is running out. Answer now with only the JSON object, using the evidence you have." });
      }
      if (cursor.state !== "generating") await move("generating", { tier, model });
      const response = await callModel({
        system: job.systemPrompt,
        turns: turnsList,
        tools: toolsEnabled && !forceSchema && job.tools.length > 0 ? toolDeclarations(job.tools) : undefined,
        responseJsonSchema: forceSchema ? outputJsonSchema : undefined,
        maxOutputTokens: job.reservedOutput,
      });
      turns++;
      turnsList.push({ role: "model", text: response.text, toolCalls: response.toolCalls, raw: response.raw });

      if (response.toolCalls.length > 0 && toolsEnabled && !forceSchema) {
        await checkpoint(true);
        await move("executing_tool", { tools: response.toolCalls.map((c) => c.name) });
        const results: { id?: string; name: string; result: Record<string, unknown> }[] = [];
        for (const call of response.toolCalls) {
          if (toolCalls >= ORCHESTRATOR_LIMITS.maxToolCalls) {
            results.push({ id: call.id, name: call.name, result: { error: "Tool-call limit reached. Answer with the evidence you have." } });
            continue;
          }
          toolCalls++;
          const t0 = deps.now();
          const result = await runTool(call.name, call.args, { reader: deps.reader, lineCounts });
          deps.onEvent?.({ type: "tool", name: call.name, ok: result.ok, ms: deps.now() - t0 });
          results.push({ id: call.id, name: call.name, result: result.output });
        }
        turnsList.push({ role: "tool", results });
        if (toolCalls >= ORCHESTRATOR_LIMITS.maxToolCalls) {
          toolsEnabled = false;
          turnsList.push({ role: "user", text: "The tool-call limit is reached. Answer now with only the JSON object, using the evidence you have." });
        }
        await move("generating", { tier, model });
        continue;
      }

      await move("validating_output");
      if (response.finishReason === "safety") throw new RunFailure("safety_blocked");
      const candidate = response.text ? extractJson(response.text) : null;
      const checked = candidate === null ? null : job.outputSchema.safeParse(candidate);
      if (!checked?.success) {
        if (correctionUsed) throw new RunFailure("bad_output");
        correctionUsed = true;
        forceSchema = true;
        const issue = checked ? describeIssue(checked.error) : response.finishReason === "max_tokens" ? "the reply was cut off; be more concise" : "no JSON object found";
        turnsList.push({ role: "user", text: `Your previous reply did not match the required JSON shape (${issue}). Reply again with only the JSON object.` });
        await move("generating", { tier, model, correction: true });
        continue;
      }

      const output = checked.data as Record<string, unknown>;
      const filtered = await filterLocations(jobType, output, lineCounts, deps.reader);

      let syntaxValid: boolean | null | undefined;
      if (jobType === "generate" && output.kind === "tests" && deps.syntaxCheck) {
        syntaxValid = await deps.syntaxCheck(String(output.language), String(output.content));
        if (syntaxValid === false && !syntaxFixUsed) {
          syntaxFixUsed = true;
          forceSchema = true;
          turnsList.push({ role: "user", text: "The test file you wrote has syntax errors. Return the corrected complete JSON object." });
          await move("generating", { tier, model, correction: "syntax" });
          continue;
        }
      }

      await move("completed");
      return outcome("completed", { result: filtered.output, citationsDropped: filtered.dropped, syntaxValid });
    }
  } catch (error) {
    if (error instanceof Stop) {
      const next = error.status === "timed_out" && !canTransition(cursor.state, "timed_out") ? "failed" : error.status;
      await safeMove(next);
      return outcome(next === "failed" ? "failed" : error.status, next === "failed" ? { error: { category: "deadline", message: SAFE_MESSAGES.deadline } } : {});
    }
    const failure = error instanceof RunFailure ? error : new RunFailure("internal");
    await safeMove("failed", { category: failure.category });
    return outcome("failed", { error: { category: failure.category, message: failure.message } });
  }

  async function safeMove(next: RunState, detail?: Record<string, unknown>) {
    if (!canTransition(cursor.state, next)) return;
    try {
      await move(next, detail);
    } catch {
      // The outcome is still returned; the stale-run sweep closes a run whose last write failed.
    }
  }

  // One model call with bounded retries for transient failures, then fallback DOWN to a cheaper tier when the chosen
  // model stays unavailable, rate limited or out of quota. Other failures end the run.
  async function callModel(request: Omit<LlmRequest, "model" | "signal">): Promise<LlmResponse> {
    const chain = deps.registry.fallbackChain(tier ?? "standard");
    let last: LlmError | null = null;
    for (const candidate of chain) {
      const spec = deps.registry.models[candidate] ?? deps.registry.models.standard;
      if (candidate !== chain[0]) {
        fallback = true;
        deps.onEvent?.({ type: "fallback", from: chain[0], to: candidate });
      }
      for (let attempt = 0; attempt < RETRY_POLICY.maxAttempts; attempt++) {
        await checkpoint(true);
        const remaining = deadlineMs - (deps.now() - started);
        const cappedByDeadline = remaining < ORCHESTRATOR_LIMITS.perCallTimeoutMs;
        const call = callSignal(options.signal, Math.max(1, Math.min(ORCHESTRATOR_LIMITS.perCallTimeoutMs, remaining)));
        attempts++;
        const t0 = deps.now();
        try {
          // Raced against the call's own signal too: a provider that ignores aborts still cannot hold the run.
          const response = await Promise.race([
            deps.provider.generate({ ...request, model: spec.id, signal: call.signal }),
            new Promise<never>((_, reject) =>
              call.signal.addEventListener("abort", () => reject(new LlmError("timeout", "The call was aborted.")), { once: true }),
            ),
          ]);
          tier = candidate;
          model = spec.id;
          usage = addUsage(usage, response.usage);
          costUsd += deps.registry.estimateCostUsd(candidate, response.usage);
          call.dispose();
          deps.onEvent?.({ type: "model", tier: candidate, model: spec.id, ms: deps.now() - t0, usage: response.usage, attempt });
          return response;
        } catch (error) {
          call.dispose();
          if (options.signal.aborted) throw new Stop("cancelled");
          const llm = error instanceof LlmError ? error : new LlmError("network", "provider call failed");
          // The call's timeout was the run's remaining time, so this is the run deadline, not a slow provider.
          if (llm.category === "timeout" && cappedByDeadline) throw new Stop("timed_out");
          last = llm;
          if (isRetryable(llm.category) && attempt < RETRY_POLICY.maxAttempts - 1) {
            const delay = backoffMillis(attempt, llm.retryAfterSeconds, deps.random ?? Math.random);
            if (deps.now() - started + delay > deadlineMs) break;
            deps.onEvent?.({ type: "retry", category: llm.category, delayMs: delay });
            await deps.sleep(delay, options.signal);
            continue;
          }
          break;
        }
      }
      // A per-call timeout here is a hung, overloaded model (deadline-capped calls already ended the run as timed_out).
      if (!last || !["unavailable", "rate_limited", "quota", "network", "timeout"].includes(last.category)) break;
    }
    throw new RunFailure(last?.category ?? "internal");
  }
}

function withoutMeta(schema: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...schema };
  delete rest.$schema;
  return rest;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid";
  return `${issue.path.join(".") || "root"}: ${issue.message}`.slice(0, 200);
}

// Drops citations, trace links and review findings whose location is not a real line range of a snapshot file.
async function filterLocations(
  jobType: JobType,
  output: Record<string, unknown>,
  lineCounts: Map<string, number>,
  reader: RepoReader,
): Promise<{ output: Record<string, unknown>; dropped: number }> {
  const listKey = jobType === "requirement_trace" ? "links" : jobType === "code_review" || jobType === "bug_scan" ? "findings" : jobType === "bug_fix_plan" ? "edits" : "citations";
  const items = (output[listKey] as (Citation & Record<string, unknown>)[]) ?? [];
  const unknownPaths = [...new Set(items.map((i) => i.path))].filter((p) => !lineCounts.has(p) && isSafeRepoPath(p)).slice(0, ORCHESTRATOR_LIMITS.maxCitationFileReads);
  for (const path of unknownPaths) {
    const text = await reader.readText(path);
    if (text !== null) lineCounts.set(path, lineCount(text));
  }
  const { valid } = validateCitations(items, lineCounts);
  const keep = new Set(valid.map((c) => `${c.path}:${c.startLine}:${c.endLine}`));
  const seen = new Set<string>();
  const kept = items.filter((item) => {
    const key = `${item.path}:${item.startLine}:${item.endLine}`;
    if (!keep.has(key)) return false;
    // Citations are de-duplicated; findings and links at the same place may legitimately differ, so they are kept.
    if (listKey === "citations" && seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { output: { ...output, [listKey]: kept }, dropped: items.length - kept.length };
}
