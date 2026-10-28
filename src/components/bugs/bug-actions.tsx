"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { FixView } from "@/server/bugs/detail";

// Client controls of the bug workspace: assignment, the stage buttons and the AI fix plan with its approval controls.
// Every button posts to the bug's route handler, which re-checks who may do it; this UI only hides what cannot work.

type Recommendation = { userId: string; name: string; role: string; score: number; reasons: string[]; openBugs: number; availability: string };

async function post(url: string, body: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: Record<string, unknown> }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: string };
    return response.ok ? { ok: true, data } : { ok: false, error: data.error ?? "The request failed. Try again." };
  } catch {
    return { ok: false, error: "The connection was lost. Try again." };
  }
}

const reload = () => window.location.reload();

// ------------------------------------------------------------------------------------------------ assignment
export function AssignPanel({ bugId, assignUrl, current, status, isAdmin }: { bugId: string; assignUrl: string; current: { name: string; source: string | null; reason: string | null } | null; status: string; isAdmin: boolean }) {
  const [options, setOptions] = useState<Recommendation[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const reassignable = ["DETECTED", "TRIAGED", "REOPENED", "ASSIGNED", "IN_PROGRESS", "BLOCKED"].includes(status);

  async function load() {
    setOpen(true);
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`${assignUrl}?bugId=${bugId}`, { cache: "no-store" });
      const data = (await response.json()) as { recommendations?: Recommendation[]; error?: string };
      if (!response.ok || !data.recommendations) setError(data.error ?? "Could not load the people.");
      else setOptions(data.recommendations);
    } catch {
      setError("Could not load the people.");
    }
    setBusy(false);
  }

  async function act(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    const result = await post(assignUrl, body);
    if (result.ok) reload();
    else {
      setError(result.error ?? "Failed.");
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-[13px]">
      <p className="text-fg-2">
        {current ? (
          <>
            Assigned to <span className="font-medium text-fg">{current.name}</span> ({current.source === "AUTO" ? "automatic" : "manual"})
            {current.reason ? <span className="block text-[12px] text-fg-3">{current.reason}</span> : null}
          </>
        ) : (
          "Not assigned."
        )}
      </p>
      {isAdmin && reassignable && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="secondary" onClick={load} disabled={busy}>
            {current ? "Reassign…" : "Assign…"}
          </Button>
          <Button size="sm" variant="secondary" onClick={() => act({ op: "auto", bugIds: [bugId] })} disabled={busy}>
            {busy ? <Spinner /> : null} Auto-assign
          </Button>
          {status === "ASSIGNED" && (
            <Button size="sm" variant="secondary" onClick={() => act({ op: "unassign", bugId, reason: "Unassigned by an admin." })} disabled={busy}>
              Unassign
            </Button>
          )}
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {open && options && (
        <ul className="max-h-72 divide-y divide-border overflow-auto rounded-lg border border-border">
          {options.length === 0 && <li className="p-3 text-fg-3">Nobody is eligible: everyone is unavailable or cannot see this project.</li>}
          {options.map((o, i) => (
            <li key={o.userId} className="flex items-start gap-3 p-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-fg">
                  {o.name} {i === 0 && <span className="ml-1 rounded bg-accent/15 px-1.5 text-[11px] text-accent">best match</span>}
                  <span className="ml-1 text-[11px] font-normal text-fg-3">{o.role.toLowerCase()}</span>
                </p>
                <p className="text-[12px] text-fg-3">{o.reasons.join("; ")}</p>
              </div>
              <Button size="sm" variant="primary" disabled={busy} onClick={() => act({ op: "assign", bugId, userId: o.userId, reason: `Assigned manually. ${o.reasons.slice(0, 2).join("; ")}.` })}>
                Assign
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ comments
export function CommentBox({ actionUrl }: { actionUrl: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="space-y-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setBusy(true);
        const result = await post(actionUrl, { op: "comment", body: text });
        if (result.ok) reload();
        else {
          setError(result.error ?? "Failed.");
          setBusy(false);
        }
      }}
    >
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} maxLength={2000} placeholder="Add a comment" aria-label="Add a comment" className="w-full rounded-lg border border-border bg-surface-2 p-2 text-[13px] text-fg" />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button size="sm" variant="secondary" type="submit" disabled={busy || !text.trim()}>
        Comment
      </Button>
    </form>
  );
}

// ------------------------------------------------------------------------------------------------ diff
function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-bg-subtle p-2 font-mono text-[12px] leading-5" aria-label="Proposed patch">
      {diff.split("\n").map((line, i) => (
        <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "block bg-success/15 text-fg" : line.startsWith("-") && !line.startsWith("---") ? "block bg-danger/15 text-fg" : line.startsWith("@@") ? "block text-info" : "block text-fg-2"}>
          {line || " "}
        </span>
      ))}
    </pre>
  );
}

const CHECK_TONE: Record<string, string> = { PASS: "text-success", FAIL: "text-danger", SKIPPED: "text-fg-3" };

function Validation({ fix }: { fix: FixView }) {
  if (!fix.validation) return null;
  return (
    <div className="space-y-1.5">
      <h4 className="text-[13px] font-medium text-fg">Validation {fix.validation.passed ? "passed" : "failed"}</h4>
      <ul className="space-y-1 text-[12.5px]">
        {fix.validation.checks.map((c) => (
          <li key={c.name}>
            <span className={`font-medium ${CHECK_TONE[c.status] ?? ""}`}>{c.status}</span> <span className="text-fg">{c.name}</span>
            <span className="block text-fg-3">{c.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ workflow
type WorkflowProps = {
  actionUrl: string;
  downloadUrl: string;
  status: string;
  canWork: boolean;
  isAdmin: boolean;
  isAssignee: boolean;
  aiConfigured: boolean;
  fixes: FixView[];
};

export function FixWorkflow({ actionUrl, downloadUrl, status, canWork, isAdmin, isAssignee, aiConfigured, fixes }: WorkflowProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const latest = fixes[0];
  const pending = fixes.find((f) => f.status === "PROPOSED");
  const previousFeedback = latest && (latest.status === "CHANGES_REQUESTED" || latest.status === "REJECTED") ? latest.decisionNote : null;

  async function run(label: string, body: Record<string, unknown>) {
    setBusy(label);
    setError(null);
    const result = await post(actionUrl, body);
    if (result.ok) reload();
    else {
      setError(result.error ?? "Failed.");
      setBusy(null);
    }
  }
  const move = (to: string, label: string) => run(label, { op: "transition", to, note });
  const isBusy = busy !== null;

  const noteBox = (placeholder: string) => <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} placeholder={placeholder} aria-label={placeholder} className="w-full rounded-lg border border-border bg-surface-2 p-2 text-[13px] text-fg" />;

  return (
    <div className="space-y-4">
      {error && <Alert tone="danger">{error}</Alert>}

      {["DETECTED", "TRIAGED", "REOPENED"].includes(status) && <p className="text-[13px] text-fg-2">Assign this bug to start the fix workflow.</p>}

      {status === "ASSIGNED" && (
        <div className="space-y-2">
          <p className="text-[13px] text-fg-2">{isAssignee ? "This bug is yours." : "Waiting for the assignee."} Starting work lets the AI propose a fix.</p>
          {canWork && (
            <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("IN_PROGRESS", "start")}>
              {busy === "start" ? <Spinner /> : null} Start work
            </Button>
          )}
        </div>
      )}

      {status === "IN_PROGRESS" && (
        <div className="space-y-2">
          {previousFeedback && <Alert tone="warning" title="Changes were requested on the last proposal">{previousFeedback}</Alert>}
          <p className="text-[13px] text-fg-2">The AI reads the code around the bug and proposes a plan and a minimal patch. Nothing is applied until you approve it.</p>
          {canWork ? (
            <>
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={isBusy || !aiConfigured} onClick={() => run("plan", { op: "plan", ...(previousFeedback ? { feedback: previousFeedback } : {}) })}>
                  {busy === "plan" ? <Spinner /> : null} {fixes.length > 0 ? "Generate a new fix plan" : "Generate AI fix plan"}
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("BLOCKED", "block")}>
                  Mark blocked
                </Button>
              </div>
              {!aiConfigured && <p className="text-[12px] text-fg-3">AI is not configured on this server.</p>}
              {busy === "plan" && <p className="text-[12px] text-fg-3">The AI is working on it. This can take up to two minutes.</p>}
              {noteBox("Reason if blocking (required to block)")}
            </>
          ) : (
            <p className="text-[12px] text-fg-3">Only the assignee or an admin can ask for a fix.</p>
          )}
        </div>
      )}

      {status === "BLOCKED" && canWork && (
        <div className="space-y-2">
          <p className="text-[13px] text-fg-2">This bug is blocked.</p>
          <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("IN_PROGRESS", "resume")}>
            Resume work
          </Button>
        </div>
      )}

      {status === "AWAITING_APPROVAL" && pending && (
        <div className="space-y-3">
          <Alert tone="info" title={`AI fix proposal v${pending.version} awaits your approval`}>
            Review the plan and the patch. Approving applies the patch to the stored working copy and validates it. Nothing is pushed to your repository.
          </Alert>
          {canWork ? (
            <>
              {noteBox("Note (required to reject or request changes)")}
              <div className="flex flex-wrap gap-2">
                <Button variant="primary" size="sm" disabled={isBusy} onClick={() => run("approve", { op: "decide", fixId: pending.id, decision: "APPROVE", note })}>
                  {busy === "approve" ? <Spinner /> : null} Approve and apply
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => run("changes", { op: "decide", fixId: pending.id, decision: "REQUEST_CHANGES", note })}>
                  Request changes
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => run("reject", { op: "decide", fixId: pending.id, decision: "REJECT", note })}>
                  Reject
                </Button>
              </div>
            </>
          ) : (
            <p className="text-[12px] text-fg-3">Only the assignee or an admin can decide.</p>
          )}
        </div>
      )}

      {status === "FIX_APPLIED" && (
        <div className="space-y-2">
          <Alert tone="success" title="Fix applied to the working copy">The patch passed validation. Test it in your own repository, then move the bug to testing.</Alert>
          {canWork && (
            <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("TESTING", "testing")}>
              Move to testing
            </Button>
          )}
        </div>
      )}

      {status === "TESTING" && canWork && (
        <div className="space-y-2">
          <p className="text-[13px] text-fg-2">Describe how the fix was tested and the result. This is kept as evidence and sent to the reviewer.</p>
          {noteBox("What was run and what happened (at least 10 characters)")}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("CODE_REVIEW", "review")}>
              {busy === "review" ? <Spinner /> : null} Request code review
            </Button>
            <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("IN_PROGRESS", "back")}>
              Back to in progress
            </Button>
          </div>
        </div>
      )}

      {status === "CODE_REVIEW" && (
        <div className="space-y-2">
          {isAssignee ? (
            <Alert tone="info" title="Waiting for code review">Someone other than you reviews the fix.</Alert>
          ) : (
            <>
              <p className="text-[13px] text-fg-2">Review the diff. Your outcome is recorded.</p>
              {noteBox("Review outcome (at least 10 characters)")}
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("QA_VERIFICATION", "qa")}>
                  {busy === "qa" ? <Spinner /> : null} Approve and send to QA
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("IN_PROGRESS", "back")}>
                  Send back
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {status === "QA_VERIFICATION" && (
        <div className="space-y-2">
          {isAssignee ? (
            <Alert tone="info" title="Waiting for QA verification">Someone other than you verifies the fix.</Alert>
          ) : (
            <>
              <p className="text-[13px] text-fg-2">Confirm the bug is gone. A bug is resolved only with written evidence.</p>
              {noteBox("Evidence that the bug is fixed (at least 10 characters)")}
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled={isBusy} onClick={() => move("RESOLVED", "resolve")}>
                  {busy === "resolve" ? <Spinner /> : null} Mark resolved
                </Button>
                <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("IN_PROGRESS", "back")}>
                  Send back
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {["RESOLVED", "REJECTED", "CANCELLED"].includes(status) && isAdmin && (
        <div className="space-y-2">
          {noteBox("Reason for reopening")}
          <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("REOPENED", "reopen")}>
            Reopen
          </Button>
        </div>
      )}

      {["DETECTED", "TRIAGED", "ASSIGNED", "REOPENED"].includes(status) && isAdmin && (
        <div className="space-y-2 border-t border-border pt-3">
          {noteBox("Reason (required to reject or cancel)")}
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("REJECTED", "rej")}>
              Reject as not a bug
            </Button>
            <Button variant="secondary" size="sm" disabled={isBusy} onClick={() => move("CANCELLED", "cancel")}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      {latest && (
        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[13px] font-semibold text-fg">
              Fix v{latest.version} · {latest.status.toLowerCase().replace(/_/g, " ")}
            </h3>
            <a href={`${downloadUrl}?diff=${latest.id}`} className="text-[12px] text-accent underline underline-offset-2">
              Download diff
            </a>
          </div>
          <p className="text-[13px] text-fg-2">{latest.plan.summary}</p>
          <ol className="list-decimal space-y-1 pl-5 text-[13px] text-fg-2">
            {latest.plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {latest.plan.risks.length > 0 && (
            <div>
              <h4 className="text-[12px] font-medium text-fg">Risks</h4>
              <ul className="list-disc pl-5 text-[12.5px] text-fg-3">
                {latest.plan.risks.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {latest.plan.testsToRun.length > 0 && (
            <div>
              <h4 className="text-[12px] font-medium text-fg">Tests to run</h4>
              <ul className="list-disc pl-5 text-[12.5px] text-fg-3">
                {latest.plan.testsToRun.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-[12px] text-fg-3">
            Model confidence: {latest.plan.confidence}
            {latest.model ? ` · ${latest.model}` : ""}
            {latest.files.length > 0 ? ` · ${latest.files.join(", ")}` : ""}
          </p>
          <DiffView diff={latest.diff} />
          <Validation fix={latest} />
          {latest.decisionNote && (
            <p className="text-[12.5px] text-fg-2">
              {latest.decidedBy ?? "Someone"}: {latest.decisionNote}
            </p>
          )}
        </div>
      )}
      {fixes.length > 1 && (
        <details className="text-[12.5px] text-fg-2">
          <summary className="cursor-pointer">Earlier proposals ({fixes.length - 1})</summary>
          <ul className="mt-1 space-y-1">
            {fixes.slice(1).map((f) => (
              <li key={f.id}>
                v{f.version}: {f.status.toLowerCase().replace(/_/g, " ")}
                {f.decisionNote ? ` — ${f.decisionNote}` : ""} ·{" "}
                <a href={`${downloadUrl}?diff=${f.id}`} className="text-accent underline underline-offset-2">
                  diff
                </a>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

export function Panel({ title, children, className }: { title: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={`p-4 ${className ?? ""}`}>
      <h2 className="mb-3 text-[14px] font-semibold text-fg">{title}</h2>
      {children}
    </Card>
  );
}
