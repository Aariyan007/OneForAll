"use client";

import { Button } from "@/components/ui/button";
import { IconAlert } from "@/components/ui/icons";

// Unexpected failure while loading the graph. Never shows internal error details.
export default function RepositoryGraphError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col items-center rounded-xl border border-dashed border-border-strong bg-surface/60 px-6 py-14 text-center">
      <span className="mb-4 inline-flex size-11 items-center justify-center rounded-xl border border-danger/30 bg-danger/10 text-danger">
        <IconAlert size={20} />
      </span>
      <h1 className="t-h2 text-fg">The repository graph could not be loaded</h1>
      <p className="t-small mt-1 max-w-sm text-fg-3">Something went wrong while reading the analysis. Nothing was changed. Try again in a moment.</p>
      <Button variant="secondary" className="mt-5" onClick={() => retry()}>
        Try again
      </Button>
    </div>
  );
}
