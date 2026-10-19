"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField, RadioCards } from "@/components/ui/form-field";
import { IconBox, IconSparkle } from "@/components/ui/icons";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { useNavigateOnRedirect } from "@/components/ui/reload";
import type { ProjectFormState } from "@/server/projects/schema";

type CreateProjectAction = (prev: ProjectFormState, formData: FormData) => Promise<ProjectFormState>;

const PROJECT_TYPES = [
  { value: "GREENFIELD", label: "Greenfield", description: "A new system built from scratch.", icon: <IconSparkle size={16} /> },
  { value: "BROWNFIELD", label: "Brownfield", description: "An existing system you are evolving.", icon: <IconBox size={16} /> },
] as const;

// `action` must arrive already bound to the organization, department and team ids, bound in a
// Server Component. Never call `.bind()` here during client render: it creates a new server
// reference on every render and sends React's form-state check into an endless suspend/retry
// loop whenever the action returns an error state.
export function CreateProjectForm({ action, cancelHref }: { action: CreateProjectAction; cancelHref?: string }) {
  const [state, formAction, pending] = useActionState<ProjectFormState, FormData>(action, {});
  // Success returns the page to open; it opens with a full load and the form stays busy until then
  // (see src/components/ui/reload.ts). Without JavaScript the form still posts to the Server Action.
  const leaving = useNavigateOnRedirect(state);

  return (
    <form action={formAction} className="flex flex-col gap-5" noValidate>
      <FormField
        label="Project name"
        name="name"
        placeholder="Platform Intelligence"
        hint="A clear, descriptive name for this project."
        required
        errors={state.fieldErrors?.name}
      />
      <FormField
        label="Description"
        name="description"
        placeholder="What this project delivers and for whom"
        optional
        multiline
        errors={state.fieldErrors?.description}
      />
      <RadioCards legend="Project type" name="projectType" defaultValue="GREENFIELD" options={PROJECT_TYPES} errors={state.fieldErrors?.projectType} />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <FormActions cancelHref={cancelHref}>
        <SubmitButton pending={pending || leaving} pendingLabel="Creating…">
          Create project
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
