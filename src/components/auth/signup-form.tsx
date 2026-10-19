"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/alert";
import { FormField } from "@/components/ui/form-field";
import { SubmitButton } from "@/components/ui/submit-button";
import { signUp } from "@/server/auth/actions";
import type { AuthFormState } from "@/server/auth/schema";

export function SignupForm({ next }: { next?: string }) {
  const [state, formAction, pending] = useActionState<AuthFormState, FormData>(signUp, {});

  if (state.message) {
    return (
      <Alert tone="success" title="Check your inbox">
        {state.message}
      </Alert>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4" noValidate>
      {next && <input type="hidden" name="next" value={next} />}
      <FormField label="Name" name="displayName" autoComplete="name" placeholder="Ada Lovelace" required errors={state.fieldErrors?.displayName} />
      <FormField label="Work email" name="email" type="email" autoComplete="email" placeholder="you@company.com" required errors={state.fieldErrors?.email} />
      <FormField
        label="Password"
        name="password"
        type="password"
        autoComplete="new-password"
        required
        errors={state.fieldErrors?.password}
      />
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      <div className="pt-1">
        <SubmitButton pending={pending} pendingLabel="Creating account…" full>
          Create account
        </SubmitButton>
      </div>
    </form>
  );
}
