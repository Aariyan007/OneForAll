// HTTP security headers for every response (applied in next.config.ts).
// The CSP allows inline scripts and styles because the App Router bootstraps with inline scripts and no nonce is set up;
// it still blocks foreign scripts, plugins, framing and foreign form targets. It ships report-only until a browser pass
// over the app shows no violations, then `enforceCsp` turns it on.

// `next dev` needs eval() (React callstack reconstruction, Turbopack HMR), so `dev` adds 'unsafe-eval'; production never does.
export function contentSecurityPolicy({ dev = false }: { dev?: boolean } = {}): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

export const CONTENT_SECURITY_POLICY = contentSecurityPolicy();

export function securityHeaders({
  enforceCsp,
  dev = false,
}: {
  enforceCsp: boolean;
  dev?: boolean;
}): { key: string; value: string }[] {
  return [
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Browsers ignore HSTS over plain http (localhost), so it is safe to send everywhere.
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
    { key: enforceCsp ? "Content-Security-Policy" : "Content-Security-Policy-Report-Only", value: contentSecurityPolicy({ dev }) },
  ];
}
