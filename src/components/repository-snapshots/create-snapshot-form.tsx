"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField } from "@/components/ui/form-field";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { useNavigateOnRedirect } from "@/components/ui/reload";
import type { SnapshotFormState } from "@/server/repository-snapshots/schema";

type CreateSnapshotAction = (prev: SnapshotFormState, formData: FormData) => Promise<SnapshotFormState>;

// `action` must arrive already bound to the organization, department, team and project ids, bound in a
// Server Component. Never call `.bind()` here during client render: it creates a new server reference on
// every render and sends React's form-state check into an endless suspend/retry loop whenever the action
// returns an error state.
export function CreateSnapshotForm({ action, cancelHref }: { action: CreateSnapshotAction; cancelHref?: string }) {
  const [state, formAction, pending] = useActionState<SnapshotFormState, FormData>(action, {});
  // Success returns the page to open; it opens with a full load and the form stays busy until then
  // (see src/components/ui/reload.ts). Without JavaScript the form still posts to the Server Action.
  const leaving = useNavigateOnRedirect(state);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormField
        label="Commit SHA"
        name="commitSha"
        placeholder="e.g. 3f2a9c1d…"
        hint="The full 40 or 64 hex-character commit id."
        mono
        required
        errors={state.fieldErrors?.commitSha}
      />
      <FormField label="Branch" name="branch" placeholder="main" hint="The branch the commit belongs to." mono required errors={state.fieldErrors?.branch} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormActions cancelHref={cancelHref}>
        <SubmitButton pending={pending || leaving} pendingLabel="Creating…">
          Create snapshot
        </SubmitButton>
      </FormActions>
      {state.redirectTo && (
        <noscript>
          <a href={state.redirectTo} className="text-[13px] text-fg underline">
            Saved. Continue
          </a>
        </noscript>
      )}
    </form>
  );
}
