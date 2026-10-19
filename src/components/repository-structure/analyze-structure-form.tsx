"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { IconSparkle } from "@/components/ui/icons";
import { useReloadOnSuccess } from "@/components/ui/reload";
import type { AnalysisActionState } from "@/server/repository-structure/schema";

type AnalyzeStructureAction = (prev: AnalysisActionState, formData: FormData) => Promise<AnalysisActionState>;

// `action` must arrive already bound to its route ids, bound in a Server Component (see DisconnectRepositoryForm).
export function AnalyzeStructureForm({ action, label }: { action: AnalyzeStructureAction; label: string }) {
  // The page shows the analysis outcome (completed, or failed with its message) after a reload: the action does not
  // revalidate (see src/components/ui/reload.ts).
  const [state, formAction, pending] = useActionState<AnalysisActionState, FormData>(action, {});
  const leaving = useReloadOnSuccess(state);
  const busy = pending || leaving;

  return (
    <form action={formAction} className="flex flex-col gap-3">
      <button type="submit" disabled={busy} aria-busy={busy} className={buttonClass("primary", "md", "w-fit")}>
        {busy ? <Spinner /> : <IconSparkle size={15} />}
        {busy ? "Analyzing…" : label}
      </button>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
    </form>
  );
}
