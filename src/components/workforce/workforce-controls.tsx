"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadOnSuccess, reloadingAction, untilPageUnload } from "@/components/ui/reload";
import { cx } from "@/lib/cx";
import {
  type ActionResult,
  type ImportState,
  applyImport,
  applyStructureImport,
  createSkill,
  previewImport,
  previewStructureImport,
  setAssignmentMode,
  setAvailability,
  setSkills,
  updateDirectoryEntry,
} from "@/server/workforce/actions";

// Client controls for the Workforce page. They only send requests; the server re-checks the caller and the database
// decides (see src/server/workforce/actions.ts).

const CONTROL =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

const AVAILABILITY_LABELS: Record<string, string> = { AVAILABLE: "Available", BUSY: "Busy", UNAVAILABLE: "Unavailable" };

function Result({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  if (result.error) return <span className="text-[12px] text-danger" role="alert">{result.error}</span>;
  if (result.success) return <span className="text-[12px] text-success" role="status">{result.success}</span>;
  return null;
}

export function AvailabilityControl({ organizationId, profileId, value, label }: { organizationId: string; profileId: string; value: string; label: string }) {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <div className="flex flex-col gap-1">
      <select
        aria-label={label}
        defaultValue={value}
        disabled={pending}
        className={cx(CONTROL, "h-8 w-36 cursor-pointer")}
        onChange={(e) => {
          const next = e.currentTarget.value;
          start(async () => setResult(await setAvailability(organizationId, profileId, next).catch(() => ({ error: "The request failed." }))));
        }}
      >
        {Object.entries(AVAILABILITY_LABELS).map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      <Result result={result} />
    </div>
  );
}

export function SkillsEditor({
  organizationId,
  profileId,
  skills,
  selected,
  label,
}: {
  organizationId: string;
  profileId: string;
  skills: { id: string; name: string }[];
  selected: string[];
  label: string;
}) {
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(selected));
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  if (skills.length === 0) return <p className="t-small text-fg-3">No skills defined yet. An owner or admin adds them below.</p>;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="sr-only">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {skills.map((s) => {
          const on = chosen.has(s.id);
          return (
            <label
              key={s.id}
              className={cx(
                "inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-[12px] transition-colors focus-within:ring-2 focus-within:ring-accent",
                on ? "border-accent/40 bg-accent/10 text-fg" : "border-border-strong text-fg-2 hover:border-fg-3",
              )}
            >
              <input
                type="checkbox"
                className="sr-only"
                checked={on}
                onChange={() => {
                  const next = new Set(chosen);
                  if (on) next.delete(s.id);
                  else next.add(s.id);
                  setChosen(next);
                  setResult(null);
                }}
              />
              {s.name}
            </label>
          );
        })}
      </div>
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          className={buttonClass("secondary", "sm")}
          onClick={() =>
            start(async () => {
              const r = await setSkills(organizationId, profileId, [...chosen]).catch(() => ({ error: "The request failed." }));
              setResult(r);
              if (reloadOnSuccess(r)) await untilPageUnload();
            })
          }
        >
          {pending && <Spinner />}
          Save skills
        </button>
        <Result result={result} />
      </div>
    </fieldset>
  );
}

export function AddSkillForm({ organizationId }: { organizationId: string }) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(reloadingAction(createSkill.bind(null, organizationId)), {});
  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-start">
      <div className="flex-1">
        <label htmlFor="new-skill" className="sr-only">
          New skill
        </label>
        <input id="new-skill" name="name" required maxLength={60} placeholder="e.g. React, PostgreSQL, API Testing" className={CONTROL} />
      </div>
      <button type="submit" disabled={pending} className={buttonClass("secondary", "md")}>
        {pending && <Spinner />}
        Add skill
      </button>
      <div className="sm:pt-2">
        <Result result={state} />
      </div>
    </form>
  );
}

export function DirectoryEntryEditor({
  organizationId,
  entry,
  departments,
}: {
  organizationId: string;
  entry: { id: string; fullName: string | null; employeeCode: string | null; jobTitle: string | null; departmentId: string | null; teamId: string | null };
  departments: { id: string; name: string; teams: { id: string; name: string }[] }[];
}) {
  const [state, formAction, pending] = useActionState<ActionResult, FormData>(reloadingAction(updateDirectoryEntry.bind(null, organizationId, entry.id)), {});
  const current = entry.teamId ?? (entry.departmentId ? `dept:${entry.departmentId}` : "none");
  return (
    <form action={formAction} className="grid gap-3 sm:grid-cols-2">
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Full name
        <input name="fullName" defaultValue={entry.fullName ?? ""} maxLength={100} className={CONTROL} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Employee code
        <input name="employeeCode" defaultValue={entry.employeeCode ?? ""} maxLength={40} className={CONTROL} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Job title
        <input name="jobTitle" defaultValue={entry.jobTitle ?? ""} maxLength={100} className={CONTROL} />
      </label>
      <label className="flex flex-col gap-1 text-[12.5px] text-fg-2">
        Home department / team
        <select name="team" defaultValue={current} className={cx(CONTROL, "cursor-pointer")}>
          <option value="none">None</option>
          {departments.map((d) => (
            <optgroup key={d.id} label={d.name}>
              <option value={`dept:${d.id}`}>{d.name} (department only)</option>
              {d.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {d.name} / {t.name}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <p className="t-small text-fg-3 sm:col-span-2">
        For a member, the home team also grants access to that team&apos;s projects. Leaving a field empty clears it.
      </p>
      <div className="flex items-center gap-2 sm:col-span-2">
        <button type="submit" disabled={pending} className={buttonClass("primary", "sm")}>
          {pending && <Spinner />}
          Save entry
        </button>
        <Result result={state} />
      </div>
    </form>
  );
}

const MODES = [
  { value: "MANUAL", label: "Manual", text: "Owners and admins pick the assignee. OneForAll shows skills, availability and workload." },
  { value: "RECOMMEND", label: "Recommendation first", text: "OneForAll ranks eligible people; an owner or admin confirms." },
  { value: "AUTO", label: "Automatic", text: "Tasks with required skills are assigned to the top-ranked eligible person when created or on request." },
] as const;

export function AssignmentModeControl({ organizationId, mode, editable }: { organizationId: string; mode: string; editable: boolean }) {
  const [value, setValue] = useState(mode);
  const [pending, start] = useTransition();
  const [result, setResult] = useState<ActionResult | null>(null);
  return (
    <fieldset className="flex flex-col gap-2" disabled={!editable || pending}>
      <legend className="sr-only">Assignment policy</legend>
      {MODES.map((m) => (
        <label key={m.value} className={cx("flex cursor-pointer gap-2.5 rounded-lg border px-3 py-2.5", value === m.value ? "border-accent/40 bg-accent/5" : "border-border")}>
          <input type="radio" name="assignment-mode" value={m.value} checked={value === m.value} onChange={() => setValue(m.value)} className="mt-1 accent-[var(--accent)]" />
          <span>
            <span className="block text-[13px] font-medium text-fg">{m.label}</span>
            <span className="t-small text-fg-3">{m.text}</span>
          </span>
        </label>
      ))}
      {editable ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={pending || value === mode}
            className={buttonClass("primary", "sm")}
            onClick={() => {
              if (value === "AUTO" && !window.confirm("Turn on automatic assignment? Tasks with required skills will be assigned without review.")) return;
              start(async () => {
                const r = await setAssignmentMode(organizationId, value).catch(() => ({ error: "The request failed." }));
                setResult(r);
                if (reloadOnSuccess(r)) await untilPageUnload();
              });
            }}
          >
            {pending && <Spinner />}
            Save policy
          </button>
          <Result result={result} />
        </div>
      ) : (
        <p className="t-small text-fg-3">Only an owner can change the assignment policy.</p>
      )}
    </fieldset>
  );
}

const OUTCOME_STYLE: Record<string, string> = { CREATE: "text-success", UPDATE: "text-info", UNCHANGED: "text-fg-3", ERROR: "text-danger" };

type ImportAction = (prev: ImportState, formData: FormData) => Promise<ImportState>;

// Shared preview -> confirm flow. Applied results belong to the preview they confirmed; a new preview replaces them.
function ImportFlow({
  previewAction: preview$,
  applyAction: apply$,
  keyLabel,
  previewFields,
  confirmText,
  note,
  done,
}: {
  previewAction: ImportAction;
  applyAction: ImportAction;
  keyLabel: string;
  previewFields?: React.ReactNode;
  confirmText: (creates: number, updates: number) => string;
  note: string;
  done: { href: string; label: string };
}) {
  const [preview, previewAction, previewing] = useActionState<ImportState, FormData>(preview$, {});
  const [applied, applyAction, applying] = useActionState<ImportState, FormData>(apply$, {});
  const appliedThisPreview = Boolean(applied.applied && applied.results && applied.hash === preview.hash);
  const shown = appliedThisPreview ? applied : preview;
  const counts = (shown.results ?? []).reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  return (
    <div className="flex flex-col gap-5">
      <form action={previewAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        {previewFields}
        <label className="flex flex-1 flex-col gap-1.5 text-[13px] font-medium text-fg">
          CSV file (UTF-8, at most 512 KiB and 2,000 rows)
          <input name="file" type="file" accept=".csv,text/csv" required className={cx(CONTROL, "h-auto py-1.5 file:mr-3 file:rounded file:border-0 file:bg-surface-3 file:px-2 file:py-1 file:text-fg")} />
        </label>
        <button type="submit" disabled={previewing || applying} className={buttonClass("secondary", "md")}>
          {previewing && <Spinner />}
          {previewing ? "Checking…" : "Preview"}
        </button>
      </form>
      {preview.error && <Alert tone="danger" title="The file cannot be imported">{preview.error}</Alert>}
      {applied.error && !appliedThisPreview && <Alert tone="danger" title="The import was not applied">{applied.error}</Alert>}

      {shown.results && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 text-[13px]" role="status">
            <span className="font-medium text-fg">{appliedThisPreview ? "Imported" : `Preview of ${preview.fileName ?? "the file"}`}:</span>
            <span className="text-success">{counts.CREATE ?? 0} new</span>
            <span className="text-info">{counts.UPDATE ?? 0} updated</span>
            <span className="text-fg-3">{counts.UNCHANGED ?? 0} unchanged</span>
            <span className="text-danger">{counts.ERROR ?? 0} with errors{appliedThisPreview ? " (skipped)" : ""}</span>
          </div>
          <div className="max-h-[420px] overflow-auto rounded-lg border border-border">
            <table className="w-full text-left text-[12.5px]">
              <thead className="sticky top-0 bg-surface-2 text-fg-3">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Row</th>
                  <th scope="col" className="px-3 py-2 font-medium">{keyLabel}</th>
                  <th scope="col" className="px-3 py-2 font-medium">Result</th>
                  <th scope="col" className="px-3 py-2 font-medium">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {shown.results.map((r, i) => (
                  <tr key={`${r.row}-${i}`}>
                    <td className="px-3 py-1.5 font-mono text-fg-3">{r.row ?? "-"}</td>
                    <td className="px-3 py-1.5 text-fg">{r.email ?? "-"}</td>
                    <td className={cx("px-3 py-1.5 font-medium", OUTCOME_STYLE[r.outcome])}>{r.outcome.toLowerCase()}</td>
                    <td className="px-3 py-1.5 text-fg-2">{r.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!appliedThisPreview && preview.csv && preview.hash && (counts.CREATE || counts.UPDATE) ? (
            <form action={applyAction} className="flex flex-wrap items-center gap-3">
              <input type="hidden" name="csv" value={preview.csv} />
              <input type="hidden" name="hash" value={preview.hash} />
              {preview.kind && <input type="hidden" name="kind" value={preview.kind} />}
              <button
                type="submit"
                disabled={applying}
                className={buttonClass("primary", "md")}
                onClick={(e) => {
                  if (!window.confirm(confirmText(counts.CREATE ?? 0, counts.UPDATE ?? 0))) e.preventDefault();
                }}
              >
                {applying && <Spinner />}
                {applying ? "Importing…" : "Confirm import"}
              </button>
              <span className="t-small text-fg-3">{note}</span>
            </form>
          ) : appliedThisPreview ? (
            <a href={done.href} className={buttonClass("primary", "md")}>
              {done.label}
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}

export function DirectoryImport({ organizationId }: { organizationId: string }) {
  return (
    <ImportFlow
      previewAction={previewImport.bind(null, organizationId)}
      applyAction={applyImport.bind(null, organizationId)}
      keyLabel="Email"
      confirmText={(c, u) => `Apply ${c} new and ${u} updated entries? Rows with errors are skipped.`}
      note="No accounts, roles or invitations are created. Members are matched by email."
      done={{ href: `/organizations/${organizationId}/workforce`, label: "Open the directory" }}
    />
  );
}

export function StructureImport({ organizationId }: { organizationId: string }) {
  return (
    <ImportFlow
      previewAction={previewStructureImport.bind(null, organizationId)}
      applyAction={applyStructureImport.bind(null, organizationId)}
      keyLabel="Name"
      previewFields={
        <label className="flex flex-col gap-1.5 text-[13px] font-medium text-fg">
          File contains
          <select name="kind" defaultValue="DEPARTMENTS" className={cx(CONTROL, "w-44 cursor-pointer")}>
            <option value="DEPARTMENTS">Departments</option>
            <option value="TEAMS">Teams</option>
          </select>
        </label>
      }
      confirmText={(c, u) => `Create ${c} and update ${u} entries? Rows with errors are skipped.`}
      note="Only departments and teams are created; nobody is added to them."
      done={{ href: `/organizations/${organizationId}/departments`, label: "Open departments" }}
    />
  );
}
