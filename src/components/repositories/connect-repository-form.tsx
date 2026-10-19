"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField, SelectField } from "@/components/ui/form-field";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { useNavigateOnRedirect } from "@/components/ui/reload";
import {
  PROVIDERS,
  PROVIDER_LABELS,
  type RepositoryFormState,
  VISIBILITIES,
  VISIBILITY_LABELS,
} from "@/server/repositories/schema";

type ConnectRepositoryAction = (prev: RepositoryFormState, formData: FormData) => Promise<RepositoryFormState>;

const PROVIDER_OPTIONS = PROVIDERS.map((value) => ({ value, label: PROVIDER_LABELS[value] }));
const VISIBILITY_OPTIONS = VISIBILITIES.map((value) => ({ value, label: VISIBILITY_LABELS[value] }));

// `action` must arrive already bound to the organization, department, team and project ids, bound in a
// Server Component. Never call `.bind()` here during client render: it creates a new server reference on
// every render and sends React's form-state check into an endless suspend/retry loop whenever the action
// returns an error state.
export function ConnectRepositoryForm({ action, cancelHref }: { action: ConnectRepositoryAction; cancelHref?: string }) {
  const [state, formAction, pending] = useActionState<RepositoryFormState, FormData>(action, {});
  // Success returns the page to open; it opens with a full load and the form stays busy until then
  // (see src/components/ui/reload.ts). Without JavaScript the form still posts to the Server Action.
  const leaving = useNavigateOnRedirect(state);
  const errors = state.fieldErrors;

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <div className="grid gap-5 sm:grid-cols-2">
        <SelectField label="Provider" name="provider" defaultValue="GITHUB" options={PROVIDER_OPTIONS} errors={errors?.provider} />
        <SelectField label="Visibility" name="visibility" defaultValue="UNKNOWN" options={VISIBILITY_OPTIONS} errors={errors?.visibility} />
      </div>
      <FormField
        label="Repository URL"
        name="repositoryUrl"
        type="url"
        placeholder="https://github.com/acme/platform"
        hint="The https URL of the repository root. Never include credentials or tokens."
        mono
        required
        errors={errors?.repositoryUrl}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <FormField label="Owner" name="owner" placeholder="acme" hint="Taken from the URL if left blank." optional errors={errors?.owner} />
        <FormField label="Repository name" name="name" placeholder="platform" hint="Taken from the URL if left blank." optional errors={errors?.name} />
      </div>
      <FormField
        label="Default branch"
        name="defaultBranch"
        placeholder="main"
        hint="The branch your team ships from."
        mono
        required
        errors={errors?.defaultBranch}
      />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormActions cancelHref={cancelHref}>
        <SubmitButton pending={pending || leaving} pendingLabel="Connecting…">
          Connect repository
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
