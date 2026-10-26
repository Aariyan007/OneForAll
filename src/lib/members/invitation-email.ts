// Pure helpers for invitation links and emails. No I/O: the Server Action sends the message (src/server/email).

// The origin invitation links point to. APP_URL (server-only, read at runtime) wins so a public URL such as a tunnel
// can change with a restart instead of a rebuild; then the Origin of the request (already checked against Host by
// Next.js for Server Actions); then the build-time NEXT_PUBLIC_SITE_URL. Anything that is not an http(s) URL is skipped.
export function resolveAppUrl(input: { appUrl: string | undefined; origin: string | null; siteUrl: string }): string {
  for (const candidate of [input.appUrl, input.origin]) {
    const origin = httpOrigin(candidate);
    if (origin) return origin;
  }
  return input.siteUrl.replace(/\/$/, "");
}

function httpOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

// The token travels in the URL fragment, which browsers never send to a server, so it does not end up in request logs.
export function invitationLink(appUrl: string, token: string): string {
  return `${appUrl}/invitations#${token}`;
}

export type InvitationEmail = { subject: string; text: string; html: string };

const expiryFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function buildInvitationEmail(input: {
  organizationName: string;
  inviterName: string;
  roleLabel: string;
  link: string;
  expiresAt: string;
}): InvitationEmail {
  const expires = expiryFormat.format(new Date(input.expiresAt));
  const subject = oneLine(`${input.inviterName} invited you to ${input.organizationName} on OneForAll`);
  const text = [
    `${input.inviterName} invited you to join ${input.organizationName} on OneForAll as ${input.roleLabel}.`,
    "",
    "Open this link to accept. Sign in, or create an account, with this email address:",
    input.link,
    "",
    `The link expires on ${expires} and works once. If you did not expect this invitation, ignore this email.`,
  ].join("\n");
  const html = `<!doctype html>
<html><body style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#111;line-height:1.5">
<p><strong>${escapeHtml(input.inviterName)}</strong> invited you to join <strong>${escapeHtml(input.organizationName)}</strong> on OneForAll as ${escapeHtml(input.roleLabel)}.</p>
<p>Sign in, or create an account, with this email address, then accept the invitation.</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 16px;background:#6366f1;color:#fff;border-radius:6px;text-decoration:none">Accept invitation</a></p>
<p style="color:#555;font-size:13px">The link expires on ${escapeHtml(expires)} and works once. If you did not expect this invitation, ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
