import "server-only";
import type { NextRequest } from "next/server";

// CSRF protection for state-changing Route Handlers (Server Actions get an equivalent check from Next.js): the
// browser's Origin must be this host. A missing Origin is refused.
export function isSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!origin || !host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Small JSON bodies only (the integration endpoints never accept uploads).
export async function readSmallJson(request: NextRequest, maxBytes = 16 * 1024): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(declared) || declared > maxBytes) return null;
  const text = await request.text();
  if (text.length > maxBytes) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
