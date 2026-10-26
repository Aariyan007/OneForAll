"use client";

import "./globals.css";

// Last-resort boundary for errors in the root layout. It replaces the root layout, so it brings its own <html> and
// <body>. Never shows internal error details; the digest lets an operator find the server log line.
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center px-6 py-16 text-center text-fg">
        <p className="font-mono text-[13px] text-fg-3">Error</p>
        <h1 className="t-h1 mt-2 text-fg">Something went wrong</h1>
        <p className="t-body mt-2 max-w-sm text-fg-2">OneForAll could not load this page. Nothing was changed. Try again in a moment.</p>
        {error.digest && <p className="mt-2 font-mono text-[12px] text-fg-3">Reference: {error.digest}</p>}
        <button
          type="button"
          onClick={() => retry()}
          className="mt-8 h-9 rounded-md border border-border-strong bg-surface px-4 text-[13px] font-medium text-fg hover:bg-bg-subtle"
        >
          Try again
        </button>
      </body>
    </html>
  );
}
