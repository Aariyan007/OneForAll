"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { IconArrowRight, IconBranch, IconCommit, IconExternal, IconNetwork } from "@/components/ui/icons";
import type { IntegrationFormState } from "@/server/integrations/actions";

// Client parts of the project Integrations page. Every state shown here comes from a server response: no optimistic
// "connected" or "imported" message is displayed before the server confirms it. Secrets are typed into password fields,
// sent once in a POST body and never shown again.

type Action = (prev: IntegrationFormState, formData: FormData) => Promise<IntegrationFormState>;

const INPUT =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store", headers: { Accept: "application/json" } });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!response.ok || !body) throw new Error(body?.error ?? "The request failed. Try again.");
  return body;
}

async function postJson<T>(url: string, payload: unknown): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    cache: "no-store",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!body) throw new Error("The request failed. Try again.");
  if (!response.ok && !("ok" in body)) throw new Error(body.error ?? "The request failed. Try again.");
  return body;
}

// A small form bound to a Server Action, with server-confirmed success / error messages.
export function ActionForm({
  action,
  submitLabel,
  pendingLabel,
  variant = "primary",
  confirm,
  children,
}: {
  action: Action;
  submitLabel: string;
  pendingLabel: string;
  variant?: "primary" | "secondary" | "danger";
  confirm?: string;
  children?: React.ReactNode;
}) {
  const [state, formAction, pending] = useActionState<IntegrationFormState, FormData>(action, {});
  return (
    <form
      action={formAction}
      onSubmit={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      className="flex flex-col gap-3"
    >
      {children}
      <div>
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass(variant, "sm")}>
          {pending && <Spinner />}
          {pending ? pendingLabel : submitLabel}
        </button>
      </div>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.success && <Alert tone="success">{state.success}</Alert>}
    </form>
  );
}

export function SecretField({ name, label, hint, autoComplete = "off" }: { name: string; label: string; hint: React.ReactNode; autoComplete?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      <input id={name} name={name} type="password" required autoComplete={autoComplete} spellCheck={false} className={`${INPUT} font-mono`} />
      <p className="text-[12px] text-fg-3">{hint}</p>
    </div>
  );
}

export function TextField({ name, label, hint, placeholder, type = "text" }: { name: string; label: string; hint?: string; placeholder?: string; type?: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      <input id={name} name={name} type={type} required placeholder={placeholder} autoComplete="off" className={INPUT} />
      {hint && <p className="text-[12px] text-fg-3">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub

type Branch = { name: string; sha: string };
type Commit = { sha: string; branch: string; message: string; authoredAt: string | null; htmlUrl: string };
type ImportResponse = { ok: boolean; error?: string; message?: string; analysisError?: string; snapshotId?: string };

export function GitHubImportPanel({ apiUrl, defaultBranch, snapshotsHref }: { apiUrl: string; defaultBranch: string; snapshotsHref: string }) {
  const router = useRouter();
  const [branches, setBranches] = useState<{ list: Branch[]; truncated: boolean } | null>(null);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [branch, setBranch] = useState(defaultBranch);
  const [commitInput, setCommitInput] = useState("");
  const [commit, setCommit] = useState<Commit | null>(null);
  const [phase, setPhase] = useState<"idle" | "resolving" | "importing">("idle");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResponse | null>(null);

  useEffect(() => {
    let active = true;
    getJson<{ ok: boolean; branches?: Branch[]; truncated?: boolean; error?: string }>(`${apiUrl}?op=branches`)
      .then((body) => {
        if (!active) return;
        if (body.ok && body.branches) setBranches({ list: body.branches, truncated: Boolean(body.truncated) });
        else setBranchError(body.error ?? "Branches could not be loaded.");
      })
      .catch((e: unknown) => active && setBranchError(e instanceof Error ? e.message : "Branches could not be loaded."));
    return () => {
      active = false;
    };
  }, [apiUrl]);

  const busy = phase !== "idle";

  const resolve = async () => {
    setPhase("resolving");
    setError(null);
    setCommit(null);
    setResult(null);
    try {
      const body = await postJson<{ ok: boolean; commit?: Commit; error?: string }>(apiUrl, { op: "resolve", branch, commit: commitInput });
      if (body.ok && body.commit) setCommit(body.commit);
      else setError(body.error ?? "The commit could not be resolved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "The commit could not be resolved.");
    } finally {
      setPhase("idle");
    }
  };

  const runImport = async () => {
    if (!commit) return;
    setPhase("importing");
    setError(null);
    setResult(null);
    try {
      const body = await postJson<ImportResponse>(apiUrl, { op: "import", branch: commit.branch, sha: commit.sha });
      setResult(body);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "The import failed.");
    } finally {
      setPhase("idle");
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="gh-branch" className="text-[13px] font-medium text-fg">
            Branch
          </label>
          {branches && branches.list.length > 0 ? (
            <select id="gh-branch" value={branch} disabled={busy} onChange={(e) => { setBranch(e.target.value); setCommit(null); }} className={INPUT}>
              {!branches.list.some((b) => b.name === branch) && <option value={branch}>{branch}</option>}
              {branches.list.map((b) => (
                <option key={b.name} value={b.name}>
                  {b.name}
                </option>
              ))}
            </select>
          ) : (
            <input id="gh-branch" value={branch} disabled={busy} onChange={(e) => { setBranch(e.target.value); setCommit(null); }} className={`${INPUT} font-mono`} />
          )}
          <p className="text-[12px] text-fg-3">
            {branchError ? <span className="text-warning">{branchError}</span> : branches ? `${branches.list.length} branches${branches.truncated ? " (first 300 shown)" : ""}` : "Loading branches…"}
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="gh-commit" className="text-[13px] font-medium text-fg">
            Commit SHA <span className="font-normal text-fg-3">(optional)</span>
          </label>
          <input
            id="gh-commit"
            value={commitInput}
            disabled={busy}
            onChange={(e) => { setCommitInput(e.target.value); setCommit(null); }}
            placeholder="Leave empty for the latest commit of the branch"
            className={`${INPUT} font-mono`}
            maxLength={40}
          />
          <p className="text-[12px] text-fg-3">A full 40-character SHA on the selected branch.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={resolve} disabled={busy || branch.trim() === ""} className={buttonClass("secondary", "sm")}>
          {phase === "resolving" ? <Spinner /> : <IconCommit size={14} />}
          {phase === "resolving" ? "Resolving…" : "Resolve commit"}
        </button>
        <button type="button" onClick={runImport} disabled={busy || !commit} className={buttonClass("primary", "sm")}>
          {phase === "importing" ? <Spinner /> : <IconBranch size={14} />}
          {phase === "importing" ? "Importing…" : "Import this commit"}
        </button>
      </div>

      {commit && (
        <div className="rounded-lg border border-border bg-surface-2/50 px-3 py-2.5 text-[12.5px]">
          <p className="text-fg-2">
            <span className="font-mono text-fg">{commit.sha.slice(0, 12)}</span> on <span className="font-mono">{commit.branch}</span>
            {commit.authoredAt && <span className="text-fg-3"> · {new Date(commit.authoredAt).toLocaleString()}</span>}
          </p>
          <p className="mt-0.5 truncate text-fg-3">{commit.message || "(no message)"}</p>
          <a href={commit.htmlUrl} target="_blank" rel="noopener noreferrer" className="mt-1 inline-flex items-center gap-1 text-accent hover:underline">
            View on GitHub <IconExternal size={11} />
          </a>
        </div>
      )}
      {phase === "importing" && (
        <p className="t-small flex items-center gap-2 text-fg-3" role="status">
          <Spinner /> Downloading exactly this commit from GitHub, validating it and running the structure analysis. Keep this page open; it can take up to two minutes.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      {result && !result.ok && (
        <Alert tone="danger" title="Import failed">
          {result.error}
          {result.snapshotId && (
            <>
              {" "}
              <Link href={`${snapshotsHref}/${result.snapshotId}`} className="underline underline-offset-2">
                Open the snapshot
              </Link>
            </>
          )}
        </Alert>
      )}
      {result?.ok && result.snapshotId && (
        <Alert tone={result.analysisError ? "warning" : "success"} title={result.analysisError ? "Imported; the structure analysis did not complete" : "Imported and analysed"}>
          {result.message} {result.analysisError}
          <span className="mt-1.5 flex flex-wrap gap-3">
            <Link href={`${snapshotsHref}/${result.snapshotId}`} className="inline-flex items-center gap-1 underline underline-offset-2">
              Open the snapshot <IconArrowRight size={12} />
            </Link>
            {!result.analysisError && (
              <Link href={`${snapshotsHref}/${result.snapshotId}/graph`} className="inline-flex items-center gap-1 underline underline-offset-2">
                <IconNetwork size={12} /> View the repository graph
              </Link>
            )}
          </span>
        </Alert>
      )}
    </div>
  );
}

type Repo = { fullName: string; owner: string; name: string; private: boolean };

export function GitHubRepositoryPicker({ apiUrl, action }: { apiUrl: string; action: Action }) {
  const [repos, setRepos] = useState<{ list: Repo[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getJson<{ ok: boolean; repositories?: Repo[]; truncated?: boolean; error?: string }>(`${apiUrl}?op=repositories`)
      .then((body) => {
        if (!active) return;
        if (body.ok && body.repositories) setRepos({ list: body.repositories, truncated: Boolean(body.truncated) });
        else setError(body.error ?? "Repositories could not be loaded.");
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : "Repositories could not be loaded."));
    return () => {
      active = false;
    };
  }, [apiUrl]);
  if (error) return <Alert tone="warning">{error}</Alert>;
  if (!repos) return <p className="t-small flex items-center gap-2 text-fg-3"><Spinner /> Loading repositories the token can access…</p>;
  if (repos.list.length === 0) return <p className="t-small text-fg-3">The token cannot access any repository.</p>;
  return (
    <ActionForm action={action} submitLabel="Connect repository" pendingLabel="Connecting…">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="gh-repository" className="text-[13px] font-medium text-fg">
          Repository
        </label>
        <select id="gh-repository" name="repository" required className={INPUT}>
          {repos.list.map((r) => (
            <option key={r.fullName} value={`${r.owner}/${r.name}`}>
              {r.fullName}
              {r.private ? " (private)" : ""}
            </option>
          ))}
        </select>
        {repos.truncated && <p className="text-[12px] text-fg-3">Only the 300 most recently updated repositories are listed.</p>}
      </div>
    </ActionForm>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Jira

type JiraProject = { id: string; key: string; name: string };

export function JiraProjectPicker({ apiUrl, action, selectedKey }: { apiUrl: string; action: Action; selectedKey: string | null }) {
  const [projects, setProjects] = useState<{ list: JiraProject[]; truncated: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    getJson<{ ok: boolean; projects?: JiraProject[]; truncated?: boolean; error?: string }>(`${apiUrl}?op=projects`)
      .then((body) => {
        if (!active) return;
        if (body.ok && body.projects) setProjects({ list: body.projects, truncated: Boolean(body.truncated) });
        else setError(body.error ?? "Jira projects could not be loaded.");
      })
      .catch((e: unknown) => active && setError(e instanceof Error ? e.message : "Jira projects could not be loaded."));
    return () => {
      active = false;
    };
  }, [apiUrl]);
  if (error) return <Alert tone="warning">{error}</Alert>;
  if (!projects) return <p className="t-small flex items-center gap-2 text-fg-3"><Spinner /> Loading Jira projects…</p>;
  if (projects.list.length === 0) return <p className="t-small text-fg-3">The Jira account cannot see any project.</p>;
  return (
    <ActionForm action={action} submitLabel={selectedKey ? "Change project" : "Select project"} pendingLabel="Saving…" variant="secondary">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="jira-project" className="text-[13px] font-medium text-fg">
          Jira project
        </label>
        <select id="jira-project" name="projectKey" required defaultValue={selectedKey ?? ""} className={INPUT}>
          <option value="" disabled>
            Choose a project
          </option>
          {projects.list.map((p) => (
            <option key={p.id} value={p.key}>
              {p.key} · {p.name}
            </option>
          ))}
        </select>
        {projects.truncated && <p className="text-[12px] text-fg-3">Only the first 200 projects are listed.</p>}
      </div>
    </ActionForm>
  );
}

type SyncResponse = { ok: boolean; error?: string; outcome?: { status: "SUCCEEDED" | "PARTIAL" | "FAILED"; message: string } };

export function JiraSyncButton({ apiUrl }: { apiUrl: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<SyncResponse | null>(null);
  const run = async () => {
    setBusy(true);
    setResult(null);
    try {
      setResult(await postJson<SyncResponse>(apiUrl, { op: "sync" }));
      router.refresh();
    } catch (e) {
      setResult({ ok: false, error: e instanceof Error ? e.message : "The sync failed." });
    } finally {
      setBusy(false);
    }
  };
  const outcome = result?.outcome;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <button type="button" onClick={run} disabled={busy} aria-busy={busy} className={buttonClass("primary", "sm")}>
          {busy && <Spinner />}
          {busy ? "Synchronizing…" : "Sync now (Jira → OneForAll)"}
        </button>
      </div>
      {busy && <p className="t-small text-fg-3" role="status">Reading the project&apos;s issues from Jira page by page…</p>}
      {result && !result.ok && <Alert tone="danger">{result.error}</Alert>}
      {outcome && (
        <Alert tone={outcome.status === "SUCCEEDED" ? "success" : outcome.status === "PARTIAL" ? "warning" : "danger"} title={outcome.status === "SUCCEEDED" ? "Sync complete" : outcome.status === "PARTIAL" ? "Sync incomplete" : "Sync failed"}>
          {outcome.message}
        </Alert>
      )}
    </div>
  );
}
