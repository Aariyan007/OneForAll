"use client";

import Link from "next/link";
import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadOnSuccess, reloadingAction, untilPageUnload } from "@/components/ui/reload";
import { cx } from "@/lib/cx";
import { DEFECT_SEVERITIES, type TaskAction } from "@/lib/tasks/workflow";
import {
  type TaskActionState,
  type TaskIds,
  addTaskComment,
  addTaskDependency,
  addTaskLink,
  declineTaskAssignment,
  removeTaskLink,
  reportTaskDefect,
  resolveTaskDefect,
  assignTask,
  autoAssignTask,
  createTaskHandoff,
  removeTaskDependency,
  respondTaskHandoff,
  setProjectTeam,
  setTaskRequiredSkills,
  transitionTask,
  updateTaskPlanning,
} from "@/server/tasks/workflow-actions";

// Client controls for the task page. They send requests only; the server re-verifies the task chain and the database
// functions decide (assignee, managers, receiving team). Results shown are the server's answers.

const CONTROL =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";
const AREA = "w-full rounded-md border border-border-strong bg-bg-subtle px-3 py-2 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

function Result({ result }: { result: TaskActionState | null | undefined }) {
  if (!result) return null;
  if (result.error) return <p className="text-[12.5px] text-danger" role="alert">{result.error}</p>;
  if (result.success) return <p className="text-[12.5px] text-success" role="status">{result.success}</p>;
  return null;
}

function useAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<TaskActionState | null>(null);
  const run = (fn: () => Promise<TaskActionState>) =>
    start(async () => {
      try {
        const r = await fn();
        setResult(r);
        if (reloadOnSuccess(r)) await untilPageUnload();
      } catch {
        setResult({ error: "The request failed. Try again." });
      }
    });
  return { pending, result, run };
}

export function TaskStatusActions({ ids, actions }: { ids: TaskIds; actions: TaskAction[] }) {
  const { pending, result, run } = useAction();
  const [reasonFor, setReasonFor] = useState<TaskAction | null>(null);
  const [reason, setReason] = useState("");
  if (actions.length === 0) return <p className="t-small text-fg-3">No status changes available to you.</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((a) => (
          <button
            key={a.to}
            type="button"
            disabled={pending || Boolean(a.blockedBy)}
            title={a.blockedBy ?? undefined}
            className={buttonClass(a.to === "CANCELLED" ? "danger" : a.to === "COMPLETED" || a.to === "IN_REVIEW" || a.to === "IN_QA" || (a.to === "IN_PROGRESS" && !a.needsReason) ? "primary" : "secondary", "sm")}
            onClick={() => {
              if (a.needsReason) {
                setReasonFor(a);
                setReason("");
              } else run(() => transitionTask(ids, a.to, ""));
            }}
          >
            {pending && <Spinner />}
            {a.label}
          </button>
        ))}
      </div>
      {actions.some((a) => a.blockedBy) && (
        <ul className="t-small text-fg-3">
          {[...new Set(actions.filter((a) => a.blockedBy).map((a) => a.blockedBy))].map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      )}
      {reasonFor && (
        <form
          className="flex flex-col gap-2 rounded-lg border border-border p-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await transitionTask(ids, reasonFor.to, reason);
              if (!r.error) setReasonFor(null);
              return r;
            });
          }}
        >
          <label htmlFor="transition-reason" className="text-[13px] font-medium text-fg">
            {reasonFor.to === "BLOCKED"
              ? "What is blocking the task?"
              : reasonFor.to === "CANCELLED"
                ? "Why is the task cancelled?"
                : reasonFor.label === "Fail QA"
                  ? "What failed in testing?"
                  : "Which changes are needed?"}
          </label>
          <textarea id="transition-reason" required maxLength={1000} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} className={AREA} />
          <div className="flex gap-2">
            <button type="submit" disabled={pending || reason.trim() === ""} className={buttonClass("primary", "sm")}>
              {reasonFor.label}
            </button>
            <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setReasonFor(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      <Result result={result} />
    </div>
  );
}

export type CandidateView = {
  userId: string;
  name: string;
  availability: string;
  reasons: string[];
  overloaded: boolean;
};

export function AssignmentPanel({
  ids,
  currentAssigneeId,
  ranked,
  ineligible,
  note,
  mode,
  assignable,
}: {
  ids: TaskIds;
  currentAssigneeId: string | null;
  ranked: CandidateView[];
  ineligible: { userId: string; name: string; reason: string }[];
  note: string | null;
  mode: "MANUAL" | "RECOMMEND" | "AUTO";
  assignable: boolean;
}) {
  const { pending, result, run } = useAction();
  const recommended = mode !== "MANUAL" ? ranked.find((c) => !c.overloaded) ?? null : null;
  const [choice, setChoice] = useState<string>(recommended?.userId ?? ranked[0]?.userId ?? "");
  const [reason, setReason] = useState("");
  if (!assignable) return <p className="t-small text-fg-3">Completed, cancelled and in-review tasks cannot be reassigned.</p>;
  return (
    <div className="flex flex-col gap-3">
      {note && <Alert tone="info">{note}</Alert>}
      {recommended && (
        <p className="t-small text-fg-2">
          Recommended: <span className="font-medium text-fg">{recommended.name}</span>. {recommended.reasons.join(" ")}
        </p>
      )}
      {ranked.length > 0 ? (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-[13px] font-medium text-fg">Eligible people, best match first</legend>
          {ranked.map((c, i) => (
            <label key={c.userId} className={cx("flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2", choice === c.userId ? "border-accent/40 bg-accent/5" : "border-border")}>
              <input type="radio" name="assignee" value={c.userId} checked={choice === c.userId} onChange={() => setChoice(c.userId)} className="mt-1 accent-[var(--accent)]" />
              <span className="min-w-0">
                <span className="block text-[13px] text-fg">
                  {i + 1}. {c.name} {c.userId === currentAssigneeId && <span className="text-fg-3">(current)</span>}
                  {c.availability === "BUSY" && <span className="ml-1 text-warning">· busy</span>}
                </span>
                <span className="t-small text-fg-3">{c.reasons.join(" ")}</span>
              </span>
            </label>
          ))}
        </fieldset>
      ) : (
        <p className="t-small text-fg-3">Nobody eligible right now.</p>
      )}
      {ineligible.length > 0 && (
        <details>
          <summary className="cursor-pointer text-[12.5px] text-fg-3 hover:text-fg">Not eligible ({ineligible.length})</summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {ineligible.map((c) => (
              <li key={c.userId} className="t-small text-fg-3">
                {c.name}: {c.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Note for the assignee (optional)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={CONTROL} />
      </label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !choice || choice === currentAssigneeId}
          className={buttonClass("primary", "sm")}
          onClick={() => run(() => assignTask(ids, choice, currentAssigneeId ?? "", recommended && choice === recommended.userId ? "RECOMMENDED" : "MANUAL", reason))}
        >
          {pending && <Spinner />}
          {recommended && choice === recommended.userId ? "Confirm recommendation" : "Assign"}
        </button>
        {mode === "AUTO" && !currentAssigneeId && (
          <button type="button" disabled={pending} className={buttonClass("secondary", "sm")} onClick={() => run(() => autoAssignTask(ids))}>
            Assign automatically
          </button>
        )}
        {currentAssigneeId && (
          <button
            type="button"
            disabled={pending}
            className={buttonClass("ghost", "sm")}
            onClick={() => {
              if (window.confirm("Unassign this task?")) run(() => assignTask(ids, "", currentAssigneeId, "MANUAL", ""));
            }}
          >
            Unassign
          </button>
        )}
      </div>
      <Result result={result} />
    </div>
  );
}

export function PlanningForm({
  ids,
  values,
}: {
  ids: TaskIds;
  values: { acceptanceCriteria: string | null; estimatedHours: number | null; dueDate: string | null; qaRequired: boolean };
}) {
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(reloadingAction(updateTaskPlanning.bind(null, ids)), {});
  return (
    <form action={formAction} className="flex flex-col gap-3">
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Acceptance criteria
        <textarea name="acceptanceCriteria" defaultValue={values.acceptanceCriteria ?? ""} maxLength={4000} rows={4} className={AREA} placeholder="What must be true for this task to be done?" />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
          Estimate (hours)
          <input name="estimatedHours" type="number" min="0.5" max="1000" step="0.5" defaultValue={values.estimatedHours ?? ""} className={CONTROL} />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
          Due date
          <input name="dueDate" type="date" defaultValue={values.dueDate ?? ""} className={CONTROL} />
        </label>
      </div>
      <label className="flex items-start gap-2 text-[12.5px] text-fg-2">
        <input name="qaRequired" type="checkbox" defaultChecked={values.qaRequired} className="mt-0.5" />
        <span>
          QA required
          <span className="block text-fg-3">An approved review goes to testing; the task can only be completed by passing QA.</span>
        </span>
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass("secondary", "sm")}>
          {pending && <Spinner />}
          Save planning
        </button>
        <Result result={state} />
      </div>
    </form>
  );
}

export function RequiredSkillsEditor({ ids, skills, selected }: { ids: TaskIds; skills: { id: string; name: string }[]; selected: string[] }) {
  const [chosen, setChosen] = useState(() => new Set(selected));
  const { pending, result, run } = useAction();
  if (skills.length === 0) return <p className="t-small text-fg-3">The organization has no skills yet (Workforce page).</p>;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-1.5">
        {skills.map((s) => {
          const on = chosen.has(s.id);
          return (
            <label key={s.id} className={cx("inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-[12px] focus-within:ring-2 focus-within:ring-accent", on ? "border-accent/40 bg-accent/10 text-fg" : "border-border-strong text-fg-2")}>
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => {
                  const next = new Set(chosen);
                  if (on) next.delete(s.id);
                  else next.add(s.id);
                  setChosen(next);
                }}
              />
              {s.name}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={pending} className={buttonClass("secondary", "sm")} onClick={() => run(() => setTaskRequiredSkills(ids, [...chosen]))}>
          {pending && <Spinner />}
          Save required skills
        </button>
        <Result result={result} />
      </div>
    </div>
  );
}

export function DependencyEditor({
  ids,
  dependencies,
  options,
  requirementsHref,
  editable,
}: {
  ids: TaskIds;
  dependencies: { id: string; title: string; status: string; requirementId: string | null }[];
  options: { id: string; title: string; status: string }[];
  requirementsHref: string; // .../projects/<id>/requirements
  editable: boolean;
}) {
  const taskHref = (requirementId: string, taskId: string) => `${requirementsHref}/${requirementId}/tasks/${taskId}`;
  const { pending, result, run } = useAction();
  const [pick, setPick] = useState("");
  const available = options.filter((o) => !dependencies.some((d) => d.id === o.id));
  return (
    <div className="flex flex-col gap-2">
      {dependencies.length === 0 ? (
        <p className="t-small text-fg-3">This task does not wait on other tasks.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {dependencies.map((d) => (
            <li key={d.id} className="flex items-center justify-between gap-2 text-[13px]">
              <span className="min-w-0 truncate">
                {d.requirementId ? <Link href={taskHref(d.requirementId, d.id)} className="text-fg hover:underline">{d.title}</Link> : d.title}{" "}
                <span className={d.status === "COMPLETED" || d.status === "CANCELLED" ? "text-success" : "text-warning"}>({d.status.toLowerCase().replace("_", " ")})</span>
              </span>
              {editable && (
                <button type="button" disabled={pending} className={buttonClass("ghost", "sm")} onClick={() => run(() => removeTaskDependency(ids, d.id))}>
                  Remove
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable && available.length > 0 && (
        <div className="flex gap-2">
          <select aria-label="Add a dependency" value={pick} onChange={(e) => setPick(e.target.value)} className={cx(CONTROL, "cursor-pointer")}>
            <option value="">Waits on…</option>
            {available.map((o) => (
              <option key={o.id} value={o.id}>
                {o.title}
              </option>
            ))}
          </select>
          <button type="button" disabled={pending || !pick} className={buttonClass("secondary", "md")} onClick={() => run(async () => { const r = await addTaskDependency(ids, pick); if (!r.error) setPick(""); return r; })}>
            Add
          </button>
        </div>
      )}
      <Result result={result} />
    </div>
  );
}

export function CommentForm({ ids, mentionable }: { ids: TaskIds; mentionable: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(reloadingAction(addTaskComment.bind(null, ids)), {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <label htmlFor="comment-body" className="sr-only">
        Comment
      </label>
      <textarea id="comment-body" name="body" required maxLength={4000} rows={3} placeholder="Progress, questions, review notes…" className={AREA} />
      {mentionable.length > 0 && (
        <details className="text-[12.5px]">
          <summary className="cursor-pointer text-fg-3 hover:text-fg">Mention people (they are notified)</summary>
          <fieldset className="mt-2 flex max-h-40 flex-wrap gap-1.5 overflow-auto">
            <legend className="sr-only">People to mention</legend>
            {mentionable.map((p) => (
              <label key={p.id} className="flex cursor-pointer items-center gap-1.5 rounded-full border border-border-strong px-2 py-0.5 text-fg-2">
                <input type="checkbox" name="mentions" value={p.id} />
                {p.name}
              </label>
            ))}
          </fieldset>
        </details>
      )}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass("secondary", "sm")}>
          {pending && <Spinner />}
          Comment
        </button>
        <Result result={state} />
      </div>
    </form>
  );
}

export function HandoffForm({ ids, teams }: { ids: TaskIds; teams: { id: string; name: string }[] }) {
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(reloadingAction(createTaskHandoff.bind(null, ids)), {});
  if (teams.length === 0) return <p className="t-small text-fg-3">No other team works on this project. An admin can add a collaborating team on the project page.</p>;
  return (
    <form action={formAction} className="flex flex-col gap-2.5">
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Receiving team
        <select name="toTeam" required className={cx(CONTROL, "cursor-pointer")} defaultValue={teams[0].id}>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Work completed
        <textarea name="summary" required maxLength={4000} rows={3} className={AREA} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Remaining work (optional)
        <textarea name="remaining" maxLength={4000} rows={2} className={AREA} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Notes, links, known blockers (optional)
        <textarea name="notes" maxLength={4000} rows={2} className={AREA} />
      </label>
      <div className="flex items-center gap-2">
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending && <Spinner />}
          Hand off
        </button>
        <Result result={state} />
      </div>
    </form>
  );
}

export function HandoffResponse({ ids, handoffId, canRespond, canCancel }: { ids: TaskIds; handoffId: string; canRespond: boolean; canCancel: boolean }) {
  const { pending, result, run } = useAction();
  const [note, setNote] = useState("");
  const [take, setTake] = useState(true);
  if (!canRespond && !canCancel) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="Note (optional)" aria-label="Handoff note" className={CONTROL} />
      <div className="flex flex-wrap items-center gap-2">
        {canRespond && (
          <>
            <label className="flex items-center gap-1.5 text-[12.5px] text-fg-2">
              <input type="checkbox" checked={take} onChange={(e) => setTake(e.target.checked)} /> Assign it to me
            </label>
            <button type="button" disabled={pending} className={buttonClass("primary", "sm")} onClick={() => run(() => respondTaskHandoff(ids, handoffId, "accept", note, take))}>
              Accept
            </button>
            <button type="button" disabled={pending} className={buttonClass("secondary", "sm")} onClick={() => run(() => respondTaskHandoff(ids, handoffId, "decline", note, false))}>
              Decline
            </button>
          </>
        )}
        {canCancel && (
          <button type="button" disabled={pending} className={buttonClass("ghost", "sm")} onClick={() => run(() => respondTaskHandoff(ids, handoffId, "cancel", note, false))}>
            Cancel handoff
          </button>
        )}
      </div>
      <Result result={result} />
    </div>
  );
}

export function ProjectTeamsEditor({
  ids,
  teams,
  available,
}: {
  ids: { organizationId: string; departmentId: string; teamId: string; projectId: string };
  teams: { id: string; name: string }[];
  available: { id: string; name: string }[];
}) {
  const { pending, result, run } = useAction();
  const [pick, setPick] = useState("");
  return (
    <div className="flex flex-col gap-2">
      {teams.length === 0 ? (
        <p className="t-small text-fg-3">Only the project&apos;s own team works on it.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {teams.map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 text-[13px] text-fg">
              {t.name}
              <button
                type="button"
                disabled={pending}
                className={buttonClass("ghost", "sm")}
                onClick={() => {
                  if (window.confirm(`Remove ${t.name} from this project? Its members lose access unless they are in the project's team.`)) run(() => setProjectTeam(ids, t.id, false));
                }}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {available.length > 0 && (
        <div className="flex gap-2">
          <select aria-label="Add a collaborating team" value={pick} onChange={(e) => setPick(e.target.value)} className={cx(CONTROL, "cursor-pointer")}>
            <option value="">Add a team…</option>
            {available.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={pending || !pick}
            className={buttonClass("secondary", "md")}
            onClick={() => {
              if (window.confirm("Members of that team will see this project, its requirements, tasks and repository.")) run(async () => { const r = await setProjectTeam(ids, pick, true); if (!r.error) setPick(""); return r; });
            }}
          >
            Add
          </button>
        </div>
      )}
      <Result result={result} />
    </div>
  );
}

// The assignee declines a task they have not started; it returns to the assignment queue.
export function DeclineAssignment({ ids }: { ids: TaskIds }) {
  const { pending, result, run } = useAction();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(true)}>
        Decline assignment
      </button>
    );
  }
  return (
    <form
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => declineTaskAssignment(ids, reason));
      }}
    >
      <label htmlFor="decline-reason" className="text-[13px] font-medium text-fg">
        Why can you not take this task?
      </label>
      <textarea id="decline-reason" required maxLength={500} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} className={AREA} />
      <div className="flex gap-2">
        <button type="submit" disabled={pending || reason.trim() === ""} className={buttonClass("danger", "sm")}>
          {pending && <Spinner />}
          Decline
        </button>
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Result result={result} />
    </form>
  );
}

const SEVERITY_LABELS: Record<string, string> = { LOW: "Low", MEDIUM: "Medium", HIGH: "High", CRITICAL: "Critical" };

export function DefectReportForm({ ids }: { ids: TaskIds }) {
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(reloadingAction(reportTaskDefect.bind(null, ids)), {});
  return (
    <form action={formAction} className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <h3 className="text-[13px] font-medium text-fg">Report a defect</h3>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_140px]">
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
          Title
          <input name="title" required maxLength={200} className={CONTROL} placeholder="What is wrong?" />
        </label>
        <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
          Severity
          <select name="severity" defaultValue="MEDIUM" className={cx(CONTROL, "cursor-pointer")}>
            {DEFECT_SEVERITIES.map((sev) => (
              <option key={sev} value={sev}>
                {SEVERITY_LABELS[sev]}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Steps to reproduce, expected and actual result
        <textarea name="details" maxLength={4000} rows={3} className={AREA} />
      </label>
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending}
          className={buttonClass("danger", "sm")}
          onClick={(e) => {
            if (!window.confirm("Report this defect? The task goes back to the assignee.")) e.preventDefault();
          }}
        >
          {pending && <Spinner />}
          Report defect
        </button>
        <Result result={state} />
      </div>
    </form>
  );
}

export function ResolveDefectButton({ ids, defectId }: { ids: TaskIds; defectId: string }) {
  const { pending, result, run } = useAction();
  const [open, setOpen] = useState(false);
  const [resolution, setResolution] = useState("");
  if (!open) {
    return (
      <button type="button" className={buttonClass("secondary", "sm")} onClick={() => setOpen(true)}>
        Mark resolved
      </button>
    );
  }
  return (
    <form
      className="mt-2 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => resolveTaskDefect(ids, defectId, resolution));
      }}
    >
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        How was it fixed? (optional)
        <input value={resolution} onChange={(e) => setResolution(e.target.value)} maxLength={2000} className={CONTROL} />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending && <Spinner />}
          Resolve
        </button>
        <button type="button" className={buttonClass("ghost", "sm")} onClick={() => setOpen(false)}>
          Cancel
        </button>
      </div>
      <Result result={result} />
    </form>
  );
}

export function LinkForm({ ids }: { ids: TaskIds }) {
  const [state, formAction, pending] = useActionState<TaskActionState, FormData>(reloadingAction(addTaskLink.bind(null, ids)), {});
  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="flex flex-1 flex-col gap-1 text-[12.5px] text-fg-2">
        Link (https)
        <input name="url" type="url" required maxLength={500} placeholder="https://github.com/org/repo/pull/123" className={CONTROL} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2 sm:w-40">
        Label
        <input name="label" maxLength={120} placeholder="Pull request" className={CONTROL} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass("secondary", "md")}>
        {pending && <Spinner />}
        Add link
      </button>
      <Result result={state} />
    </form>
  );
}

export function RemoveLinkButton({ ids, linkId }: { ids: TaskIds; linkId: string }) {
  const { pending, result, run } = useAction();
  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" disabled={pending} className={buttonClass("ghost", "sm")} onClick={() => run(() => removeTaskLink(ids, linkId))}>
        Remove
      </button>
      <Result result={result} />
    </span>
  );
}
