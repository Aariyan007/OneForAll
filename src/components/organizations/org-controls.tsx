"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadWithNotice, reloadingAction, untilPageUnload } from "@/components/ui/reload";
import { renameOrganization } from "@/server/organizations/actions";
import { assignQueueAutomatically } from "@/server/overview/actions";

// Organization overview and settings controls. They only send requests; the server re-checks the caller's role and
// the database decides (RLS for the rename, the assignment functions for the queue).

const CONTROL =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

export function RenameOrganizationForm({ organizationId, name }: { organizationId: string; name: string }) {
  const [state, formAction, pending] = useActionState(reloadingAction(renameOrganization.bind(null, organizationId)), {});
  return (
    <form action={formAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
      <label className="flex flex-1 flex-col gap-1.5 text-[13px] font-medium text-fg">
        Organization name
        <input name="name" required maxLength={100} defaultValue={name} className={CONTROL} />
      </label>
      <button type="submit" disabled={pending} className={buttonClass("primary", "md")}>
        {pending && <Spinner />}
        Save name
      </button>
      {state.error && <p className="text-[12.5px] text-danger" role="alert">{state.error}</p>}
    </form>
  );
}

export function AssignQueueButton({ organizationId, count }: { organizationId: string; count: number }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        disabled={pending || count === 0}
        className={buttonClass("primary", "sm", "w-fit")}
        onClick={() => {
          if (!window.confirm(`Assign up to ${Math.min(count, 25)} queued task${count === 1 ? "" : "s"} automatically? Tasks without required skills or an eligible person stay unassigned.`)) return;
          setError(null);
          start(async () => {
            const r: { error?: string; success?: string } = await assignQueueAutomatically(organizationId).catch(() => ({ error: "The request failed. Try again." }));
            if (r.error) {
              setError(r.error);
              return;
            }
            reloadWithNotice({ tone: "success", message: r.success ?? "Done." });
            await untilPageUnload();
          });
        }}
      >
        {pending && <Spinner />}
        Assign queue automatically
      </button>
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
