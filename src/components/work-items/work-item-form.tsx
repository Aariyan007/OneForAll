"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField, SelectField } from "@/components/ui/form-field";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { useNavigateOnRedirect } from "@/components/ui/reload";
import { PRIORITIES, type WorkItemFormState } from "@/server/requirements/schema";

type WorkItemAction = (prev: WorkItemFormState, formData: FormData) => Promise<WorkItemFormState>;

const PRIORITY_OPTIONS = PRIORITIES.map((value) => ({ value, label: value.charAt(0) + value.slice(1).toLowerCase() }));

// Shared by the "new requirement" and "new task" pages.
// `action` must arrive already bound to its route ids, bound in a Server Component. Never call
// `.bind()` here during client render: it creates a new server reference on every render and sends
// React's form-state check into an endless suspend/retry loop whenever the action returns an error state.
export function WorkItemForm({
  action,
  submitLabel,
  kind = "requirement",
  cancelHref,
}: {
  action: WorkItemAction;
  submitLabel: string;
  kind?: "requirement" | "task";
  cancelHref?: string;
}) {
  const [state, formAction, pending] = useActionState<WorkItemFormState, FormData>(action, {});
  // Success returns the page to open; it opens with a full load and the form stays busy until then
  // (see src/components/ui/reload.ts). Without JavaScript the form still posts to the Server Action.
  const leaving = useNavigateOnRedirect(state);
  const isTask = kind === "task";

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormField
        label="Title"
        name="title"
        placeholder={isTask ? "Add organization login form" : "Secure organization authentication"}
        hint={isTask ? "A concrete piece of work someone can pick up." : "A short statement of what must be delivered."}
        required
        errors={state.fieldErrors?.title}
      />
      <FormField
        label="Description"
        name="description"
        placeholder={isTask ? "Implementation notes, acceptance criteria…" : "Context, scope and acceptance criteria…"}
        optional
        multiline
        rows={4}
        errors={state.fieldErrors?.description}
      />
      <div className="sm:max-w-[240px]">
        <SelectField label="Priority" name="priority" defaultValue="MEDIUM" options={PRIORITY_OPTIONS} errors={state.fieldErrors?.priority} />
      </div>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormActions cancelHref={cancelHref}>
        <SubmitButton pending={pending || leaving} pendingLabel="Creating…">
          {submitLabel}
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
