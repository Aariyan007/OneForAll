"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/alert";
import { Button, Spinner } from "@/components/ui/button";

type Summary = { assigned: { bugId: string; title: string; name: string; reason: string }[]; left: { bugId: string; title: string; reason: string }[] };

// Assigns every unassigned open bug of the project to the best eligible people (the database re-checks each one).
export function AutoAssignButton({ endpoint, unassigned }: { endpoint: string; unassigned: number }) {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ op: "auto" }) });
      const data = (await response.json()) as Summary & { error?: string };
      if (!response.ok) setError(data.error ?? "Auto-assign failed.");
      else setSummary(data);
    } catch {
      setError("Auto-assign failed. Try again.");
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2">
      <Button variant="secondary" size="sm" onClick={run} disabled={busy || unassigned === 0}>
        {busy ? <Spinner /> : null} Auto-assign {unassigned} unassigned
      </Button>
      {error && <Alert tone="danger">{error}</Alert>}
      {summary && (
        <Alert tone={summary.left.length > 0 ? "warning" : "success"} title={`Assigned ${summary.assigned.length}, left ${summary.left.length}`}>
          <ul className="mt-1 space-y-0.5 text-[12.5px]">
            {summary.assigned.map((a) => (
              <li key={a.bugId}>
                {a.title} → <span className="font-medium">{a.name}</span>
              </li>
            ))}
            {summary.left.map((l) => (
              <li key={l.bugId}>
                {l.title}: {l.reason}
              </li>
            ))}
          </ul>
          <button className="mt-2 underline underline-offset-2" onClick={() => window.location.reload()}>
            Refresh the list
          </button>
        </Alert>
      )}
    </div>
  );
}
