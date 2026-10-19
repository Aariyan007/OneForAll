"use client";

import Link from "next/link";
import { useActionState, useEffect } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField } from "@/components/ui/form-field";
import { navigateWithNotice } from "@/components/ui/reload";
import { FormActions, SubmitButton } from "@/components/ui/submit-button";
import { createOrganization } from "@/server/organizations/actions";
import type { CreateOrganizationState } from "@/server/organizations/schema";

export function CreateOrganizationForm() {
  // On success the new organization opens with a full page load, so the sidebar and its pages come from the server
  // (the action does not revalidate; see src/components/ui/reload.ts).
  // The Server Action is used directly, so the form also works without JavaScript (the "Created" alert links on).
  const [state, formAction, pending] = useActionState<CreateOrganizationState, FormData>(createOrganization, {});
  const created = state.organization;
  useEffect(() => {
    if (created) {
      navigateWithNotice(`/organizations/${created.id}/departments`, {
        tone: "success",
        title: `Created ${created.name}`,
        message: `Slug ${created.slug} · your role: ${created.role}.`,
      });
    }
  }, [created]);
  const leaving = Boolean(created);

  return (
    <div className="flex flex-col gap-5">
      {state.organization && (
        <Alert tone="success" title={`Created ${state.organization.name}`}>
          Slug <span className="font-mono">{state.organization.slug}</span> · your role: {state.organization.role}.{" "}
          <Link href={`/organizations/${state.organization.id}/departments`} className="font-medium text-fg underline-offset-2 hover:underline">
            Open departments
          </Link>
        </Alert>
      )}
      <form action={formAction} className="flex flex-col gap-5" noValidate>
        <FormField
          label="Organization name"
          name="name"
          placeholder="Acme Engineering"
          hint="Usually your company name. A URL-friendly slug is generated from it."
          required
          errors={state.fieldErrors?.name}
        />
        {state.error && <Alert tone="danger">{state.error}</Alert>}
        <FormActions>
          <SubmitButton pending={pending || leaving} pendingLabel="Creating…">
            Create organization
          </SubmitButton>
        </FormActions>
      </form>
    </div>
  );
}
