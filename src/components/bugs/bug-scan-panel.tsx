"use client";

import { useRef, useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { IconSparkle } from "@/components/ui/icons";

export type PublicScan = {
  id: string;
  status: string;
  batches_total: number;
  completed_batches: number[];
  failed_batches: number[];
  files_total: number;
  files_planned: number;
  bugs_found: number;
  bugs_new: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
};

type Props = { endpoint: string; snapshotId: string; snapshotLabel: string; initialScan: PublicScan | null; configured: boolean };

const STATUS_TEXT: Record<string, string> = {
  RUNNING: "Scanning",
  COMPLETED: "Scan complete",
  PARTIAL: "Scan partly complete",
  FAILED: "Scan failed",
  CANCELLED: "Scan cancelled",
};

async function call(endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<{ scan: PublicScan | null; error?: string }> {
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const data = (await response.json().catch(() => null)) as { scan?: PublicScan | null; error?: string } | null;
  if (!response.ok) return { scan: null, error: data?.error ?? "The request failed. Try again." };
  return { scan: data?.scan ?? null };
}

// Drives a bug scan from the browser: the server processes batches in bounded steps (each step is one request), this
// loop asks for the next step until the scan is over. Closing the tab only pauses it; "Continue" picks up where it stopped.
export function BugScanPanel({ endpoint, snapshotId, snapshotLabel, initialScan, configured }: Props) {
  const [scan, setScan] = useState<PublicScan | null>(initialScan);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);

  async function drive(current: PublicScan) {
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    let latest = current;
    try {
      while (latest.status === "RUNNING" && !controller.signal.aborted) {
        const result = await call(endpoint, { op: "step", snapshotId, scanId: latest.id }, controller.signal);
        if (result.error || !result.scan) {
          setError(result.error ?? "The scan stopped unexpectedly.");
          break;
        }
        latest = result.scan;
        setScan(latest);
        // A step that ends with the scan still running but nothing pending means the provider stopped it; avoid a hot loop.
        if (latest.completed_batches.length + latest.failed_batches.length >= latest.batches_total) break;
      }
    } catch (e) {
      if (!(e instanceof DOMException && e.name === "AbortError")) setError("The connection was lost. The scan can be continued.");
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  async function start() {
    setError(null);
    setBusy(true);
    const result = await call(endpoint, { op: "start", snapshotId });
    if (result.error || !result.scan) {
      setBusy(false);
      setError(result.error ?? "The scan could not be started.");
      return;
    }
    setScan(result.scan);
    await drive(result.scan);
  }

  async function resume() {
    if (!scan) return;
    setError(null);
    setBusy(true);
    const result = await call(endpoint, { op: "resume", snapshotId, scanId: scan.id });
    if (result.error || !result.scan) {
      setBusy(false);
      setError(result.error ?? "The scan could not be resumed.");
      return;
    }
    setScan(result.scan);
    await drive(result.scan);
  }

  async function cancel() {
    if (!scan) return;
    abort.current?.abort();
    const result = await call(endpoint, { op: "cancel", snapshotId, scanId: scan.id });
    if (result.scan) setScan(result.scan);
  }

  const done = scan ? scan.completed_batches.length + scan.failed_batches.length : 0;
  const pct = scan && scan.batches_total > 0 ? Math.round((done / scan.batches_total) * 100) : 100;
  const pending = scan ? scan.batches_total - scan.completed_batches.length : 0;
  const running = scan?.status === "RUNNING";

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-[15px] font-semibold text-fg">
            <IconSparkle size={16} /> AI bug scan
          </h2>
          <p className="t-small mt-1 max-w-2xl text-fg-2">
            Scans the whole project ({snapshotLabel}) in bounded batches of files, most-depended-on files first. Every finding must quote the code it points at;
            findings whose quote is not at the cited lines are discarded.
          </p>
        </div>
        <div className="flex gap-2">
          {running && busy && (
            <Button variant="secondary" size="sm" onClick={cancel}>
              Cancel
            </Button>
          )}
          {running && !busy && (
            <Button variant="primary" size="sm" onClick={() => scan && drive(scan)}>
              Continue scan
            </Button>
          )}
          {!running && scan && scan.status !== "COMPLETED" && pending > 0 && (
            <Button variant="secondary" size="sm" onClick={resume} disabled={busy || !configured}>
              Resume ({pending} batch{pending === 1 ? "" : "es"} left)
            </Button>
          )}
          {!running && (
            <Button variant="primary" size="sm" onClick={start} disabled={busy || !configured}>
              {busy ? <Spinner /> : null} {scan ? "Scan again" : "Scan this repository"}
            </Button>
          )}
        </div>
      </div>

      {!configured && (
        <Alert tone="warning" title="AI is not configured" className="mt-3">
          The server has no GEMINI_API_KEY, so scans cannot run. Existing bugs remain visible.
        </Alert>
      )}
      {error && (
        <Alert tone="danger" title="Scan problem" className="mt-3">
          {error}
        </Alert>
      )}

      {scan && (
        <div className="mt-4 space-y-2" aria-live="polite">
          <div className="flex flex-wrap items-center justify-between gap-2 text-[13px]">
            <span className="font-medium text-fg">
              {STATUS_TEXT[scan.status] ?? scan.status}
              {running && busy ? "…" : ""}
            </span>
            <span className="text-fg-2">
              {done} of {scan.batches_total} batches · {scan.files_planned} of {scan.files_total} files planned
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className="h-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} />
          </div>
          <p className="t-small text-fg-3">
            {scan.bugs_new} new bugs, {scan.bugs_found - scan.bugs_new} already known · {(scan.input_tokens + scan.output_tokens).toLocaleString()} tokens
            {scan.failed_batches.length > 0 && ` · ${scan.failed_batches.length} batch(es) failed`}
          </p>
          {scan.error_message && <p className="t-small text-fg-3">{scan.error_message}</p>}
        </div>
      )}
    </Card>
  );
}
