"use client";

import { useActionState } from "react";
import { Spinner, buttonClass } from "@/components/ui/button";
import { IconUnlink } from "@/components/ui/icons";
import { useReloadOnSuccess } from "@/components/ui/reload";
import type { RepositoryActionResult } from "@/server/repositories/schema";

type DisconnectRepositoryAction = (prev: RepositoryActionResult, formData: FormData) => Promise<RepositoryActionResult>;

// `action` must arrive already bound to its route ids, bound in a Server Component (see ConnectRepositoryForm).
export function DisconnectRepositoryForm({ action }: { action: DisconnectRepositoryAction }) {
  // On success the page is reloaded (the action does not revalidate; see src/components/ui/reload.ts). The Server
  // Action is used directly, so the form also works without JavaScript.
  const [state, formAction, pending] = useActionState<RepositoryActionResult, FormData>(action, {});
  const leaving = useReloadOnSuccess(state);
  const busy = pending || leaving;

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <button type="submit" disabled={busy} aria-busy={busy} className={buttonClass("danger", "sm")}>
        {busy ? <Spinner /> : <IconUnlink size={14} />}
        {busy ? "Disconnecting…" : "Disconnect"}
      </button>
      {state.error && (
        <p role="alert" className="text-[12.5px] text-danger">
          {state.error}
        </p>
      )}
    </form>
  );
}
