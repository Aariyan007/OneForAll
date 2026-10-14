"use client";

import { useActionState, useState, type FormEvent } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { IconFileCode, IconPlus } from "@/components/ui/icons";
import { SMALLER_ARCHIVE_TIPS, type SelectedFile, formatBytes, validateArchiveSelection } from "@/lib/repository-sources/upload";
import type { SourceUploadState } from "@/server/repository-sources/actions";

type UploadAction = (prev: SourceUploadState, formData: FormData) => Promise<SourceUploadState>;
type UploadResponse = { ok?: boolean; error?: string; changed?: boolean };

const NETWORK_MESSAGE = "The upload did not complete. Check your connection and try again; reload the page to see the snapshot's current state.";

// Posts the archive to the snapshot's upload Route Handler (`uploadUrl`). The maximum size is passed in by the server
// (ARCHIVE_LIMITS). The checks here are for immediate feedback only: the server repeats every one of them.
// Synchronous: the request stays open until the archive is processed. Without JavaScript the form still posts to the
// same URL and the server redirects back to the snapshot page.
export function SourceUploadForm({ uploadUrl, label, maxBytes, hint }: { uploadUrl: string; label: string; maxBytes: number; hint: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedFile | null>(null);
  const selection = validateArchiveSelection(selected, maxBytes);
  const canSubmit = selection.ok && !pending;
  const showError = selected !== null && !selection.ok;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;
    // Read the form before disabling the file input: a disabled control is left out of FormData.
    const body = new FormData(event.currentTarget);
    setError(null);
    setPending(true);
    let reload = false;
    try {
      const response = await fetch(uploadUrl, { method: "POST", body, headers: { Accept: "application/json" } });
      const result = (await response.json().catch(() => ({}))) as UploadResponse;
      if (result.ok || result.changed) {
        // The outcome (recorded files, analysis, or a recorded failure) is in the database: show the fresh page.
        reload = true;
        window.location.reload();
      } else {
        setError(result.error ?? NETWORK_MESSAGE);
      }
    } catch {
      setError(NETWORK_MESSAGE);
    } finally {
      // Stay pending while the page reloads so the form cannot be submitted twice.
      if (!reload) setPending(false);
    }
  }

  return (
    <form action={uploadUrl} method="post" encType="multipart/form-data" onSubmit={onSubmit} className="flex flex-col gap-3" aria-busy={pending}>
      <div>
        <label htmlFor="archive" className="t-small mb-1.5 block font-medium text-fg">
          Source archive (.zip, at most {formatBytes(maxBytes)})
        </label>
        <input
          id="archive"
          name="archive"
          type="file"
          accept=".zip,application/zip"
          required
          disabled={pending}
          aria-describedby="archive-hint archive-status"
          aria-invalid={showError}
          onChange={(event) => {
            const file = event.target.files?.[0];
            setSelected(file ? { name: file.name, size: file.size } : null);
            setError(null);
          }}
          className="block w-full max-w-md cursor-pointer rounded-md border border-border-strong bg-bg-subtle text-[13px] text-fg-2 file:mr-3 file:cursor-pointer file:border-0 file:border-r file:border-border-strong file:bg-surface-2 file:px-3 file:py-2 file:text-[13px] file:font-medium file:text-fg focus:border-accent focus:outline-none disabled:opacity-60"
        />
        <p id="archive-hint" className="t-small mt-1.5 max-w-xl text-fg-3">
          {hint}
        </p>
      </div>

      <div id="archive-status" aria-live="polite" className="flex flex-col gap-2">
        {selected && (
          <p className="t-small flex flex-wrap items-center gap-x-1.5 text-fg-2" data-testid="archive-selection">
            <IconFileCode size={13} className="text-fg-3" />
            <span className="font-medium text-fg">{selected.name}</span>
            <span className="tabular-nums">· {formatBytes(selected.size)}</span>
            <span className="text-fg-3">(limit {formatBytes(maxBytes)})</span>
          </p>
        )}
        {showError && !selection.ok && (
          <Alert tone="danger" title={selection.reason === "too-large" ? "Archive too large" : "This file cannot be uploaded"}>
            {selection.message}
            {selection.reason === "too-large" && (
              <ul className="mt-1.5 list-disc pl-4">
                {SMALLER_ARCHIVE_TIPS.map((tip) => (
                  <li key={tip}>{tip}</li>
                ))}
              </ul>
            )}
          </Alert>
        )}
      </div>

      <button type="submit" disabled={!canSubmit} aria-disabled={!canSubmit} className={buttonClass("primary", "md", "w-fit")}>
        {pending ? <Spinner /> : <IconPlus size={15} />}
        {pending ? "Processing archive…" : label}
      </button>
      {!selected && !pending && <p className="t-small text-fg-3">Choose a .zip file to enable the upload.</p>}
      {pending && (
        <p className="t-small flex items-center gap-1.5 text-fg-3" role="status">
          <IconFileCode size={13} />
          Validating, recording and analysing in this request. Keep this page open until it finishes.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </form>
  );
}

export function MarkFailedForm({ action }: { action: UploadAction }) {
  const [state, formAction, pending] = useActionState<SourceUploadState, FormData>(action, {});
  return (
    <form action={formAction} className="flex flex-col gap-2">
      <button type="submit" disabled={pending} className={buttonClass("secondary", "sm", "w-fit")}>
        {pending && <Spinner />}
        Mark as failed
      </button>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.success && <Alert tone="success">{state.success}</Alert>}
    </form>
  );
}
