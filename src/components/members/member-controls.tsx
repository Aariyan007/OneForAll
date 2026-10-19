"use client";

import { useActionState, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { reloadOnSuccess, untilPageUnload } from "@/components/ui/reload";
import { ROLE_LABELS, type OrgRole } from "@/lib/authz/permissions";
import { cx } from "@/lib/cx";
import { type MemberActionState, changeMemberRole, inviteMember, removeMember, revokeInvitation, setMemberSuspended } from "@/server/members/actions";

// Client controls for the Members page. They only send requests: every action re-checks the caller's role on the
// server and in the database, and the page shows what the server answered.

const CONTROL =
  "h-9 w-full rounded-md border border-border-strong bg-bg-subtle px-3 text-[13px] text-fg placeholder:text-fg-3 outline-none transition-colors focus:border-accent";

export function InviteMemberForm({ organizationId, roles }: { organizationId: string; roles: OrgRole[] }) {
  const [state, formAction, pending] = useActionState<MemberActionState, FormData>(inviteMember.bind(null, organizationId), {});
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <form action={formAction} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor="invite-email" className="text-[13px] font-medium text-fg">
            Email
          </label>
          <input id="invite-email" name="email" type="email" required autoComplete="off" placeholder="name@company.com" className={CONTROL} />
        </div>
        <div className="flex flex-col gap-1.5 sm:w-44">
          <label htmlFor="invite-role" className="text-[13px] font-medium text-fg">
            Role
          </label>
          <select id="invite-role" name="role" defaultValue={roles.includes("MEMBER") ? "MEMBER" : roles[0]} className={cx(CONTROL, "cursor-pointer")}>
            {roles.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>
        <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass("primary", "md")}>
          {pending && <Spinner />}
          {pending ? "Creating…" : "Create invitation"}
        </button>
      </form>
      {state.error && <Alert tone="danger">{state.error}</Alert>}
      {state.inviteLink && (
        <Alert tone="success" title={state.success}>
          <span className="block">
            No email provider is configured, so send this one-time link to {state.invitedEmail} yourself. It expires in 7 days and only
            works for an account with that email address. It is shown once.
          </span>
          <span className="mt-2 flex flex-col gap-2 sm:flex-row">
            <input readOnly value={state.inviteLink} aria-label="Invitation link" className={cx(CONTROL, "font-mono text-[12px]")} onFocus={(e) => e.currentTarget.select()} />
            <button
              type="button"
              className={buttonClass("secondary", "md")}
              onClick={() => {
                navigator.clipboard
                  ?.writeText(state.inviteLink!)
                  .then(() => setCopied(true))
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <button type="button" className={buttonClass("ghost", "md")} onClick={() => window.location.reload()}>
              Done
            </button>
          </span>
        </Alert>
      )}
    </div>
  );
}

function useServerAction() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<MemberActionState | null>(null);
  const run = (action: () => Promise<MemberActionState>, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    start(async () => {
      try {
        const r = await action();
        setResult(r);
        if (reloadOnSuccess(r)) await untilPageUnload();
      } catch {
        setResult({ error: "The request failed. Try again." });
      }
    });
  };
  return { pending, result, run };
}

export function MemberRoleControl({ organizationId, memberId, name, role }: { organizationId: string; memberId: string; name: string; role: OrgRole }) {
  const { pending, result, run } = useServerAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <select
        aria-label={`Role of ${name}`}
        defaultValue={role}
        disabled={pending}
        className={cx(CONTROL, "h-8 w-36 cursor-pointer")}
        onChange={(e) => {
          const next = e.currentTarget.value;
          const select = e.currentTarget;
          if (!window.confirm(`Change ${name}'s role to ${ROLE_LABELS[next as OrgRole]}?`)) {
            select.value = role;
            return;
          }
          run(() => changeMemberRole(organizationId, memberId, next));
        }}
      >
        <option value="ADMIN">{ROLE_LABELS.ADMIN}</option>
        <option value="MEMBER">{ROLE_LABELS.MEMBER}</option>
      </select>
      {result?.error && <span className="text-[12px] text-danger" role="alert">{result.error}</span>}
    </div>
  );
}

export function RemoveMemberButton({ organizationId, memberId, name, self }: { organizationId: string; memberId: string; name: string; self: boolean }) {
  const { pending, result, run } = useServerAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className={buttonClass("danger", "sm")}
        onClick={() =>
          run(
            () => removeMember(organizationId, memberId),
            self
              ? "Leave this organization? You will lose access to it immediately."
              : `Remove ${name} from this organization? They lose access immediately and their tasks here are unassigned.`,
          )
        }
      >
        {pending && <Spinner />}
        {self ? "Leave" : "Remove"}
      </button>
      {result?.error && <span className="text-[12px] text-danger" role="alert">{result.error}</span>}
    </div>
  );
}

export function RevokeInvitationButton({ organizationId, invitationId, email }: { organizationId: string; invitationId: string; email: string }) {
  const { pending, result, run } = useServerAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className={buttonClass("secondary", "sm")}
        onClick={() => run(() => revokeInvitation(organizationId, invitationId), `Revoke the invitation for ${email}? The link stops working.`)}
      >
        {pending && <Spinner />}
        Revoke
      </button>
      {result?.error && <span className="text-[12px] text-danger" role="alert">{result.error}</span>}
    </div>
  );
}

export function SuspendMemberButton({ organizationId, memberId, name, suspended }: { organizationId: string; memberId: string; name: string; suspended: boolean }) {
  const { pending, result, run } = useServerAction();
  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        disabled={pending}
        className={buttonClass(suspended ? "secondary" : "ghost", "sm")}
        onClick={() =>
          run(
            () => setMemberSuspended(organizationId, memberId, !suspended),
            suspended
              ? `Reactivate ${name}? They regain access with their previous role.`
              : `Suspend ${name}? They lose access to this organization immediately and their open tasks here are unassigned. Their role is kept for reactivation.`,
          )
        }
      >
        {pending && <Spinner />}
        {suspended ? "Reactivate" : "Suspend"}
      </button>
      {result?.error && <span className="text-[12px] text-danger" role="alert">{result.error}</span>}
    </div>
  );
}
