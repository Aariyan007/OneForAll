import "server-only";
import nodemailer from "nodemailer";
import type { InvitationEmail } from "@/lib/members/invitation-email";

// Outgoing email over SMTP (Gmail by default). SERVER-ONLY: the credentials are read from the environment on the
// server, never NEXT_PUBLIC_*, never logged and never sent to the browser. For Gmail, SMTP_PASSWORD is a Google
// "app password" (2-Step Verification must be on), not the account password. Without SMTP_USER and SMTP_PASSWORD
// nothing is sent and callers fall back to showing the link (see docs/manual-setup-checklist.md).

type SmtpConfig = { host: string; port: number; user: string; password: string; from: string };

function getSmtpConfig(): SmtpConfig | null {
  const user = process.env.SMTP_USER?.trim();
  const password = process.env.SMTP_PASSWORD?.replace(/\s+/g, "");
  if (!user || !password) return null;
  const port = Number(process.env.SMTP_PORT ?? 465);
  return {
    host: process.env.SMTP_HOST?.trim() || "smtp.gmail.com",
    port: Number.isInteger(port) && port > 0 ? port : 465,
    user,
    password,
    from: process.env.SMTP_FROM?.trim() || `OneForAll <${user}>`,
  };
}

export function isEmailConfigured(): boolean {
  return getSmtpConfig() !== null;
}

export type SendResult = { sent: true } | { sent: false; reason: "not-configured" | "failed" };

export async function sendEmail(to: string, message: InvitationEmail): Promise<SendResult> {
  const config = getSmtpConfig();
  if (!config) return { sent: false, reason: "not-configured" };
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: { user: config.user, pass: config.password },
    connectionTimeout: 10_000,
    socketTimeout: 20_000,
  });
  try {
    await transport.sendMail({ from: config.from, to, subject: message.subject, text: message.text, html: message.html });
    return { sent: true };
  } catch (error) {
    // Log the SMTP error code only: the message can echo addresses or server responses.
    console.error("Email delivery failed", (error as { code?: string }).code ?? "unknown");
    return { sent: false, reason: "failed" };
  }
}
