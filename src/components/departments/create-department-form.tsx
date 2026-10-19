"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField } from "@/components/ui/form-field";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { useNavigateOnRedirect } from "@/components/ui/reload";
import type { DepartmentFormState } from "@/server/departments/schema";

type CreateDepartmentAction = (prev: DepartmentFormState, formData: FormData) => Promise<DepartmentFormState>;

// `action` must arrive already bound to the organization id, bound in a Server Component.
// Calling `.bind()` here, during client render, makes a new server reference on every render,
// which sends React's server-side form-state check into an endless suspend/retry loop whenever
// the action returns an error state (see the page for the bind).
export function CreateDepartmentForm({ action, cancelHref }: { action: CreateDepartmentAction; cancelHref?: string }) {
  const [state, formAction, pending] = useActionState<DepartmentFormState, FormData>(action, {});
  // Success returns the page to open; it opens with a full load and the form stays busy until then
  // (see src/components/ui/reload.ts). Without JavaScript the form still posts to the Server Action.
  const leaving = useNavigateOnRedirect(state);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormField
        label="Name"
        name="name"
        placeholder="Engineering"
        hint="Must be unique within the organization."
        required
        errors={state.fieldErrors?.name}
      />
      <FormField
        label="Description"
        name="description"
        placeholder="Product development and engineering"
        hint="What this department owns."
        optional
        multiline
        errors={state.fieldErrors?.description}
      />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormActions cancelHref={cancelHref}>
        <SubmitButton pending={pending || leaving} pendingLabel="Creating…">
          Create department
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
