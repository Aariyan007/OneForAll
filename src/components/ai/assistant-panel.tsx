"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Spinner, buttonClass } from "@/components/ui/button";
import { describeUsage, providerLabel, type RunMetrics } from "@/lib/ai/present";
import { cx } from "@/lib/cx";
import { ResultView } from "./result-view";

// AI Assistant for one project. It only sends requests: the run route re-verifies the session, the project chain and
// the snapshot, and the database re-checks visibility, the organization switch and quotas. Progress comes from the
// run's real lifecycle events; the answer is shown only once, after server-side validation.

type Job = "code_qa" | "requirement_trace" | "code_review" | "generate";
type Tab = "ask" | "trace" | "review" | "generate";

const TAB_JOB: Record<Tab, Job> = { ask: "code_qa", trace: "requirement_trace", review: "code_review", generate: "generate" };
const TABS: { id: Tab; label: string; hint: string }[] = [
  { id: "ask", label: "Ask about the code", hint: "Questions answered from this snapshot, with line references." },
  { id: "trace", label: "Requirement ↔ code", hint: "Find the code that implements a requirement and what is missing." },
  { id: "review", label: "Review / explain error", hint: "Review a file, or explain an error log against the code." },
  { id: "generate", label: "Tests / docs", hint: "Draft unit tests or documentation for a file. Never applied automatically." },
];

const STEP_LABELS: Record<string, string> = {
  validating: "Checking the request",
  retrieving_context: "Gathering relevant code",
  generating: "Thinking",
  executing_tool: "Reading the repository",
  validating_output: "Verifying the answer",
};

const CONTROL =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";
const AREA = "w-full rounded-md border border-border-strong bg-bg-subtle px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

type Snapshot = { id: string; commitSha: string; branch: string | null; textFiles: number };
type Run = {
  id: string;
  jobType: string;
  status: string;
  createdAt: string;
  input: unknown;
  output: unknown;
  errorMessage: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolCalls: number;
  modelCalls: number;
  mine: boolean;
  metrics: RunMetrics | null;
};
// What the run route sends when a run ends: the numbers of the persisted run plus what only the live result has.
type Metrics = {
  provider: string | null;
  model: string | null;
  usageReported: boolean;
  costKnown: boolean;
  baselineTokensEstimate: number | null;
  contextTokensEstimate: number;
  techniques: string[];
  attemptLog: RunMetrics["attemptLog"];
  usage: { inputTokens: number; outputTokens: number; cachedInputTokens: number; thinkingTokens: number };
  costUsd: number;
  turns: number;
  attempts: number;
  toolCalls: number;
  fallback: boolean;
  citationsDropped: number;
  syntaxValid: boolean | null;
  durationMs: number;
};

const toRunMetrics = (m: Metrics): RunMetrics => ({
  provider: m.provider,
  model: m.model,
  usageReported: m.usageReported,
  inputTokens: m.usage.inputTokens,
  outputTokens: m.usage.outputTokens,
  thinkingTokens: m.usage.thinkingTokens,
  cachedInputTokens: m.usage.cachedInputTokens,
  costUsd: m.costUsd,
  costKnown: m.costKnown,
  attempts: m.attempts,
  fallback: m.fallback,
  baselineTokensEstimate: m.baselineTokensEstimate,
  contextTokensEstimate: m.contextTokensEstimate,
  techniques: m.techniques,
  attemptLog: m.attemptLog,
});
type Finished = { job: Job; status: string; output: Record<string, unknown> | null; error: { category: string; message: string } | null; metrics: Metrics | null };

export function AssistantPanel(props: {
  projectPath: string;
  snapshotsHref: string;
  snapshots: Snapshot[];
  selectedSnapshotId: string | null;
  files: string[];
  requirements: { id: string; title: string; status: string }[];
  configured: boolean;
  providers: string[];
  enabled: boolean;
  initialTab: Tab;
  initialRequirementId?: string;
  runs: Run[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(props.initialTab);
  const [question, setQuestion] = useState("");
  const [requirementId, setRequirementId] = useState(props.initialRequirementId ?? props.requirements[0]?.id ?? "");
  const [reviewMode, setReviewMode] = useState<"review" | "explain_error">("review");
  const [path, setPath] = useState("");
  const [errorText, setErrorText] = useState("");
  const [kind, setKind] = useState<"tests" | "docs">("tests");
  const [symbol, setSymbol] = useState("");
  const [instructions, setInstructions] = useState("");

  const [running, setRunning] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [steps, setSteps] = useState<string[]>([]);
  const [tools, setTools] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [finished, setFinished] = useState<Finished | null>(null);
  const [requestError, setRequestError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Set synchronously when a run starts. `running` is state and still reads false until React re-renders, so two quick
  // submits (double click, held Enter) would both pass a check on it and start two runs.
  const busyRef = useRef(false);

  useEffect(() => {
    if (!running) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 500);
    return () => clearInterval(timer);
  }, [running]);

  const snapshotId = props.selectedSnapshotId;
  const disabled = !props.configured || !props.enabled || !snapshotId;
  const viewerHref = (l: { path: string; startLine: number; endLine: number }) =>
    `${props.snapshotsHref}/${snapshotId}/files?${new URLSearchParams({ path: l.path, from: String(l.startLine), to: String(l.endLine) })}#L${l.startLine}`;

  function inputFor(): Record<string, unknown> | string {
    if (tab === "ask") return question.trim().length >= 3 ? { question: question.trim() } : "Write a question of at least 3 characters.";
    if (tab === "trace") return requirementId ? { requirementId } : "Choose a requirement.";
    if (tab === "review") {
      if (reviewMode === "review") return path ? { mode: "review", path } : "Choose a file to review.";
      return errorText.trim().length >= 10 ? { mode: "explain_error", errorText: errorText.trim() } : "Paste an error message or stack trace.";
    }
    if (!path) return "Choose a file.";
    return { kind, path, ...(symbol.trim() ? { symbol: symbol.trim() } : {}), ...(instructions.trim() ? { instructions: instructions.trim() } : {}) };
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (disabled || running || busyRef.current) return;
    const input = inputFor();
    if (typeof input === "string") {
      setRequestError(input);
      return;
    }
    const job = TAB_JOB[tab];
    busyRef.current = true;
    setRequestError(null);
    setFinished(null);
    setSteps([]);
    setTools([]);
    setNotes([]);
    setElapsed(0);
    setRunId(null);
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`${props.projectPath}/ai/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotId, job, input }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const body = (await response.json().catch(() => null)) as { error?: string } | null;
        setRequestError(body?.error ?? "The request failed. Try again.");
        return;
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (line) handleLine(job, JSON.parse(line));
        }
      }
    } catch {
      if (!controller.signal.aborted) setRequestError("The connection was interrupted. The run stops when the connection closes.");
    } finally {
      busyRef.current = false;
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleLine(job: Job, line: Record<string, unknown>) {
    if (line.type === "started") setRunId(String(line.runId));
    if (line.type === "event") {
      const event = line.event as { type: string; state?: string; name?: string; category?: string; from?: string; to?: string };
      if (event.type === "state" && event.state) setSteps((s) => [...s, event.state!]);
      if (event.type === "tool" && event.name) setTools((t) => [...t, event.name!]);
      if (event.type === "retry") setNotes((n) => [...n, `The model was busy (${event.category}); retrying.`]);
      if (event.type === "fallback") {
        const named = event as { fromProvider?: string; toProvider?: string };
        setNotes((n) => [...n, named.toProvider && named.toProvider !== named.fromProvider ? `Switched from ${providerLabel(named.fromProvider)} to ${providerLabel(named.toProvider)}.` : `Switched from the ${event.from} model to the ${event.to} model.`]);
      }
    }
    if (line.type === "result") {
      setFinished({
        job,
        status: String(line.status),
        output: (line.result as Record<string, unknown> | null) ?? null,
        error: (line.error as Finished["error"]) ?? null,
        metrics: (line.metrics as Metrics | null) ?? null,
      });
    }
  }

  async function cancel() {
    if (runId) await fetch(`${props.projectPath}/ai/runs/${runId}/cancel`, { method: "POST" }).catch(() => undefined);
    abortRef.current?.abort();
    busyRef.current = false;
    setRunning(false);
    setFinished({ job: TAB_JOB[tab], status: "cancelled", output: null, error: { category: "cancelled", message: "Cancelled." }, metrics: null });
  }

  const current = steps.at(-1);

  return (
    <div className="flex flex-col gap-5">
      {!props.configured && (
        <Alert tone="warning" title="The AI assistant is not configured">
          An administrator must set GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY on the server (see docs/manual-setup-checklist.md).
        </Alert>
      )}
      {props.configured && !props.enabled && (
        <Alert tone="warning" title="The AI assistant is turned off">
          An owner or admin turned it off for this organization in Organization settings.
        </Alert>
      )}
      <Alert tone="info" title="What is sent to the AI provider">
        Your request and the relevant code excerpts of the selected snapshot are sent to one of the AI providers this server uses
        ({props.providers.length > 0 ? props.providers.map((p) => providerLabel(p)).join(", ") : "none configured"}), chosen per task; if one is
        unavailable the same request goes to the next. On free tiers a provider may use requests to improve its products. Recognisable secrets
        are redacted first. Do not use it on code you may not share.
      </Alert>

      <div className="flex flex-col gap-1.5 sm:max-w-md">
        <label htmlFor="ai-snapshot" className="text-[13px] font-medium text-fg">
          Snapshot
        </label>
        <select
          id="ai-snapshot"
          className={cx(CONTROL, "cursor-pointer")}
          value={snapshotId ?? ""}
          disabled={running}
          onChange={(e) => router.push(`?${new URLSearchParams({ snapshot: e.target.value, tab })}`)}
        >
          {props.snapshots.map((s) => (
            <option key={s.id} value={s.id} disabled={s.textFiles === 0}>
              {s.commitSha.slice(0, 12)}
              {s.branch ? ` · ${s.branch}` : ""} · {s.textFiles > 0 ? `${s.textFiles} files` : "no stored text"}
            </option>
          ))}
        </select>
      </div>

      <div role="tablist" aria-label="AI jobs" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            disabled={running}
            onClick={() => {
              setTab(t.id);
              setRequestError(null);
            }}
            className={cx(
              "-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors",
              tab === t.id ? "border-accent text-fg" : "border-transparent text-fg-3 hover:text-fg-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      <p className="-mt-2 text-[12.5px] text-fg-3">{TABS.find((t) => t.id === tab)?.hint}</p>

      <datalist id="ai-files">
        {props.files.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>

      <form onSubmit={submit} className="flex flex-col gap-3">
        {tab === "ask" && (
          <textarea
            aria-label="Question"
            className={AREA}
            rows={3}
            maxLength={2000}
            placeholder="How are overdue tasks found? Where is the session expiry checked?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        )}
        {tab === "trace" &&
          (props.requirements.length === 0 ? (
            <p className="text-[13px] text-fg-3">This project has no requirements yet. Create one under Requirements first.</p>
          ) : (
            <select aria-label="Requirement" className={cx(CONTROL, "cursor-pointer")} value={requirementId} onChange={(e) => setRequirementId(e.target.value)}>
              {props.requirements.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.title} ({r.status.toLowerCase()})
                </option>
              ))}
            </select>
          ))}
        {tab === "review" && (
          <>
            <div className="flex gap-4 text-[13px] text-fg-2">
              {(["review", "explain_error"] as const).map((mode) => (
                <label key={mode} className="flex cursor-pointer items-center gap-1.5">
                  <input type="radio" name="review-mode" checked={reviewMode === mode} onChange={() => setReviewMode(mode)} />
                  {mode === "review" ? "Review a file" : "Explain an error"}
                </label>
              ))}
            </div>
            {reviewMode === "review" ? (
              <input aria-label="File" list="ai-files" className={CONTROL} placeholder="src/tasks/store.ts" value={path} onChange={(e) => setPath(e.target.value)} />
            ) : (
              <textarea
                aria-label="Error message or stack trace"
                className={cx(AREA, "font-mono text-[12px]")}
                rows={6}
                maxLength={8000}
                placeholder="Paste the error message and stack trace"
                value={errorText}
                onChange={(e) => setErrorText(e.target.value)}
              />
            )}
          </>
        )}
        {tab === "generate" && (
          <>
            <div className="flex flex-col gap-3 sm:flex-row">
              <select aria-label="What to write" className={cx(CONTROL, "cursor-pointer sm:w-40")} value={kind} onChange={(e) => setKind(e.target.value as "tests" | "docs")}>
                <option value="tests">Unit tests</option>
                <option value="docs">Documentation</option>
              </select>
              <input aria-label="File" list="ai-files" className={CONTROL} placeholder="src/tasks/store.ts" value={path} onChange={(e) => setPath(e.target.value)} />
              <input aria-label="Symbol (optional)" className={cx(CONTROL, "sm:w-56")} placeholder="Symbol (optional)" value={symbol} onChange={(e) => setSymbol(e.target.value)} />
            </div>
            <input
              aria-label="Extra instructions (optional)"
              className={CONTROL}
              maxLength={1000}
              placeholder="Extra instructions (optional), e.g. use node:test"
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
            />
          </>
        )}
        {requestError && <Alert tone="danger">{requestError}</Alert>}
        <div className="flex items-center gap-2">
          <button type="submit" disabled={disabled || running} aria-busy={running} className={buttonClass("primary", "md")}>
            {running && <Spinner />}
            {running ? "Working…" : "Run"}
          </button>
          {running && (
            <button type="button" onClick={cancel} className={buttonClass("ghost", "md")}>
              Cancel
            </button>
          )}
        </div>
      </form>

      {(running || steps.length > 0) && (
        <div className="rounded-lg border border-border bg-surface/60 p-4" aria-live="polite">
          <div className="flex items-center justify-between text-[13px]">
            <span className="flex items-center gap-2 text-fg">
              {running && <Spinner />}
              {running ? (STEP_LABELS[current ?? ""] ?? "Starting") : finished ? `Finished: ${finished.status.replace("_", " ")}` : "Stopped"}
            </span>
            <span className="tabular-nums text-fg-3">{elapsed}s</span>
          </div>
          <ol className="mt-3 flex flex-wrap gap-1.5">
            {steps.map((s, i) => (
              <li key={i}>
                <Badge tone={s === "failed" || s === "timed_out" ? "danger" : s === "completed" ? "success" : "muted"}>{STEP_LABELS[s] ?? s.replace("_", " ")}</Badge>
              </li>
            ))}
          </ol>
          {tools.length > 0 && <p className="mt-2 text-[12px] text-fg-3">Tools used: {tools.join(", ")}</p>}
          {notes.map((n, i) => (
            <p key={i} className="mt-1 text-[12px] text-warning">
              {n}
            </p>
          ))}
        </div>
      )}

      {finished && (
        <div className="rounded-lg border border-border bg-surface p-4">
          {finished.output && finished.status === "completed" ? (
            <ResultView job={finished.job} output={finished.output} viewerHref={viewerHref} />
          ) : (
            <Alert tone={finished.status === "cancelled" ? "info" : "danger"} title={finished.status === "cancelled" ? "Cancelled" : "The assistant could not answer"}>
              {finished.error?.message ?? "Unknown error."}
            </Alert>
          )}
          {finished.metrics && <MetricsLine metrics={finished.metrics} />}
        </div>
      )}

      <RunHistory runs={props.runs} viewerHref={viewerHref} />
    </div>
  );
}

function UsageBlock({ metrics, costLabel }: { metrics: RunMetrics; costLabel?: string }) {
  const usage = describeUsage(metrics, { costLabel });
  return (
    <div className="space-y-0.5">
      <div>{[usage.model, `${metrics.attempts} provider call${metrics.attempts === 1 ? "" : "s"}`].filter(Boolean).join(" · ")}</div>
      <div>Tokens: {usage.tokens}</div>
      <div>{usage.savings}</div>
      <div>{usage.cost}</div>
      {usage.routing.map((line) => (
        <div key={line} className="text-warning">
          {line}
        </div>
      ))}
      {usage.techniques && <div>Applied: {usage.techniques}</div>}
    </div>
  );
}

function MetricsLine({ metrics }: { metrics: Metrics }) {
  return (
    <div className="mt-4 border-t border-border pt-3 text-[12px] text-fg-3">
      <UsageBlock metrics={toRunMetrics(metrics)} costLabel={metrics.provider === "gemini" ? "est. paid-tier cost" : undefined} />
      <div className="mt-1">
        {metrics.turns} model call{metrics.turns === 1 ? "" : "s"}, {metrics.toolCalls} tool call{metrics.toolCalls === 1 ? "" : "s"} · {(metrics.durationMs / 1000).toFixed(1)} s
      </div>
      {metrics.citationsDropped > 0 && <div>{metrics.citationsDropped} reference(s) the model gave did not match the snapshot and were removed.</div>}
      {metrics.syntaxValid === false && <div className="text-warning">The generated tests still have syntax errors; review them before use.</div>}
      {metrics.syntaxValid === true && <div>The generated tests parse without syntax errors (not run).</div>}
    </div>
  );
}

const JOB_LABELS: Record<string, string> = {
  code_qa: "Question",
  requirement_trace: "Requirement trace",
  code_review: "Review / error",
  generate: "Tests / docs",
};

function summary(run: Run): string {
  const input = (run.input ?? {}) as Record<string, unknown>;
  const text = String(input.question ?? input.path ?? input.errorText ?? (input.requirementId ? "Requirement" : ""));
  return text.length > 90 ? `${text.slice(0, 90)}…` : text;
}

function RunHistory({ runs, viewerHref }: { runs: Run[]; viewerHref: (l: { path: string; startLine: number; endLine: number }) => string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (runs.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <h2 className="text-[14px] font-medium text-fg">Recent runs</h2>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {runs.map((run) => (
          <li key={run.id} className="p-3">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <Badge tone={run.status === "completed" ? "success" : run.status === "failed" || run.status === "timed_out" ? "danger" : "muted"}>{run.status.replace("_", " ")}</Badge>
              <span className="text-fg-2">{JOB_LABELS[run.jobType] ?? run.jobType}</span>
              <span className="min-w-0 flex-1 truncate text-fg">{summary(run)}</span>
              {/* Formatted in the viewer's locale and time zone, which differ from the server's: without this React discards the server HTML on hydration. */}
              <span className="text-[12px] text-fg-3" suppressHydrationWarning>
                {new Date(run.createdAt).toLocaleString()}
              </span>
              {!run.mine && <Badge tone="muted">teammate</Badge>}
              {run.output !== null && run.status === "completed" && (
                <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(open === run.id ? null : run.id)}>
                  {open === run.id ? "Hide" : "Show"}
                </button>
              )}
            </div>
            {run.status !== "completed" && run.errorMessage && <p className="mt-1 text-[12px] text-fg-3">{run.errorMessage}</p>}
            {open === run.id && run.output !== null && (
              <div className="mt-3">
                <ResultView job={run.jobType} output={run.output as Record<string, unknown>} viewerHref={viewerHref} />
                <div className="mt-3 text-[12px] text-fg-3">
                  {run.metrics ? (
                    <UsageBlock metrics={run.metrics} costLabel={run.metrics.provider === "gemini" ? "est. paid-tier cost" : undefined} />
                  ) : (
                    <div>{run.model} · usage was not tracked for this run</div>
                  )}
                  <div className="mt-1">
                    {run.modelCalls} model calls, {run.toolCalls} tool calls
                  </div>
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
