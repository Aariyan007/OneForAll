"use client";

import Link from "next/link";
import { useEffect, useState, useTransition } from "react";
import { Alert } from "@/components/ui/alert";
import { Spinner, buttonClass } from "@/components/ui/button";
import { ROLE_LABELS, isOrgRole } from "@/lib/authz/permissions";
import { type InvitationPreview, acceptInvitation, previewInvitation } from "@/server/members/actions";

// The invitation link carries its token in the URL fragment (#...), which browsers never send to a server. The token
// is kept in this tab's sessionStorage only while the person signs in or creates an account, then removed.
const STORAGE_KEY = "ofa.invitation";

function readToken(): string | null {
  const fromHash = window.location.hash.replace(/^#/, "");
  try {
    if (fromHash) {
      sessionStorage.setItem(STORAGE_KEY, fromHash);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      return fromHash;
    }
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return fromHash || null;
  }
}

function forget() {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // storage unavailable: nothing to remove
  }
}

export function InvitationAccept({ signedIn, email }: { signedIn: boolean; email: string | null }) {
  const [token, setToken] = useState<string | null | undefined>(undefined);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  // The fragment exists only in the browser, so it is read after hydration (deferred to keep the effect body free of
  // synchronous state updates).
  useEffect(() => {
    let active = true;
    const t = readToken();
    queueMicrotask(() => active && setToken(t));
    if (t && signedIn) {
      previewInvitation(t)
        .then((result) => active && setPreview(result))
        .catch(() => active && setPreview({ ok: false, error: "The invitation could not be loaded. Try again." }));
    }
    return () => {
      active = false;
    };
  }, [signedIn]);

  if (token === undefined) return <p className="t-small flex items-center gap-2 text-fg-3"><Spinner /> Reading the invitation…</p>;
  if (!token) {
    return <Alert tone="warning" title="No invitation found">Open the full invitation link you received. It ends with a long code after a # sign.</Alert>;
  }
  if (!signedIn) {
    return (
      <div className="flex flex-col gap-4">
        <p className="t-body text-fg-2">Sign in, or create an account with the email address the invitation was sent to. You will come back here to accept it.</p>
        <div className="flex flex-wrap gap-2">
          <Link href="/login?next=/invitations" className={buttonClass("primary", "md")}>Sign in</Link>
          <Link href="/signup?next=/invitations" className={buttonClass("secondary", "md")}>Create account</Link>
        </div>
      </div>
    );
  }
  if (!preview) return <p className="t-small flex items-center gap-2 text-fg-3"><Spinner /> Checking the invitation…</p>;
  if (!preview.ok) return <Alert tone="danger" title="Invitation not available">{preview.error}</Alert>;

  const role = isOrgRole(preview.role) ? ROLE_LABELS[preview.role] : preview.role;
  if (preview.status !== "PENDING") {
    const text = preview.status === "EXPIRED" ? "This invitation has expired. Ask for a new one." : preview.status === "ACCEPTED" ? "This invitation was already used." : "This invitation was revoked.";
    return <Alert tone="warning" title={`Invitation to ${preview.organizationName}`}>{text}</Alert>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-lg border border-border bg-surface-2/50 px-4 py-3">
        <p className="text-[14px] font-semibold text-fg">{preview.organizationName}</p>
        <p className="t-small text-fg-2">
          Role: {role} · sent to {preview.emailHint} · expires {new Date(preview.expiresAt).toLocaleString()}
        </p>
      </div>
      {!preview.emailMatches ? (
        <Alert tone="warning" title="Different account">
          You are signed in as {email ?? "another account"}, but this invitation was sent to {preview.emailHint}. Sign out and sign in (or create an
          account) with that address.
        </Alert>
      ) : (
        <div>
          <button
            type="button"
            disabled={pending}
            className={buttonClass("primary", "md")}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await acceptInvitation(token);
                if (result.ok) {
                  forget();
                  window.location.assign(`/organizations/${result.organizationId}/departments`);
                } else setError(result.error);
              })
            }
          >
            {pending && <Spinner />}
            Accept and join {preview.organizationName}
          </button>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}
