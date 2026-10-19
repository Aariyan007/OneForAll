"use client";

import { useEffect } from "react";
import { type PageNoticeData, type StoredPageNotice, parseStoredNotice, sameOriginPath } from "@/lib/navigation";

export type { PageNoticeData };

// After a successful Server Action that changed server-rendered data, the page is loaded again from the server.
// Server Actions the UI uses call neither revalidatePath nor redirect(): on this Next.js version (16.2.9) applying a
// revalidated page in place, or the page a redirect() returns, was observed to leave the client transition pending
// (the change was saved, the UI kept showing "pending"). A full page load always shows the current server state.
// See docs/rbac-workforce.md, section 7.

// Awaited (or returned from a useActionState action) once the page is being left: the transition stays pending, so the
// submit button stays disabled and queued submissions never run while the browser loads the next page. Without it the
// button is enabled again for the moment between the action's result and the page unloading, and a second click can
// submit the same change twice.
export function untilPageUnload(): Promise<never> {
  return new Promise<never>(() => {});
}

// Reloads after a result without an error. Returns whether it did; callers then `await untilPageUnload()`.
export function reloadOnSuccess(result: { error?: string } | null | undefined): boolean {
  if (!result || result.error) return false;
  window.location.reload();
  return true;
}

// Wraps a useActionState action: a result with `success` reloads the page (its message is shown again after the
// reload) and the action never settles (see untilPageUnload). Errors and field errors are returned as before.
export function reloadingAction<S extends { error?: string; success?: string }>(
  action: (prev: S, formData: FormData) => Promise<S>,
): (prev: S, formData: FormData) => Promise<S> {
  return async (prev, formData) => {
    const result = await action(prev, formData);
    if (!result.success || result.error) return result;
    reloadWithNotice({ tone: "success", message: result.success });
    return untilPageUnload();
  };
}

// For forms whose useActionState runs a Server Action directly (bound in a Server Component), which keeps the form
// working without JavaScript (React posts it as a plain form): once the state reports success the page is left with a
// full load. The returned flag is true from the render that shows the result, so the caller keeps the submit button
// disabled and a second click cannot submit the same change again while the next page loads.
export function useNavigateOnRedirect(state: { redirectTo?: string } | null | undefined): boolean {
  useEffect(() => {
    navigateOnRedirect(state);
  }, [state]);
  return Boolean(state?.redirectTo);
}

export function useReloadOnSuccess(state: { error?: string; success?: string } | null | undefined): boolean {
  useEffect(() => {
    if (state?.success && !state.error) reloadWithNotice({ tone: "success", message: state.success });
  }, [state]);
  return Boolean(state?.success && !state?.error);
}

// Server Actions return the page to open after a successful create (`redirectTo`, built on the server from verified
// ids) instead of calling redirect(). Only same-origin paths are followed. Returns whether it navigated.
export function navigateOnRedirect(result: { redirectTo?: string } | null | undefined): boolean {
  const path = sameOriginPath(result?.redirectTo, window.location.origin);
  if (!path) return false;
  window.location.assign(path);
  return true;
}

// A confirmation that survives the full page load which follows a change. It is kept in sessionStorage for the
// path it was saved for and shown once by <PageNotice /> (app shell); it holds only UI text, never data or secrets.
const NOTICE_KEY = "oneforall:page-notice";

function saveNotice(path: string, notice: PageNoticeData) {
  try {
    window.sessionStorage.setItem(NOTICE_KEY, JSON.stringify({ ...notice, path } satisfies StoredPageNotice));
  } catch {
    // Storage unavailable (private mode, blocked): the change is still shown by the reloaded page itself.
  }
}

export function reloadWithNotice(notice: PageNoticeData) {
  saveNotice(window.location.pathname, notice);
  window.location.reload();
}

// Returns whether it navigated (only same-origin paths are followed).
export function navigateWithNotice(href: string, notice: PageNoticeData): boolean {
  const path = sameOriginPath(href, window.location.origin);
  if (!path) return false;
  saveNotice(new URL(path, window.location.origin).pathname, notice);
  window.location.assign(path);
  return true;
}

// Read once per page load (the stored notice is removed on first read) and only for the path it was saved for.
let pageNotice: PageNoticeData | null | undefined;
let pageNoticePath: string | null = null;

export function readPageNotice(pathname: string): PageNoticeData | null {
  if (pageNotice === undefined) {
    let raw: string | null = null;
    try {
      raw = window.sessionStorage.getItem(NOTICE_KEY);
      window.sessionStorage.removeItem(NOTICE_KEY);
    } catch {
      raw = null;
    }
    pageNotice = parseStoredNotice(raw, pathname);
    pageNoticePath = pathname;
  }
  // Leaving the page (client navigation) drops it, so it is never shown on another page.
  if (pageNotice && pageNoticePath !== pathname) pageNotice = null;
  return pageNotice;
}

export function subscribePageNotice() {
  return () => {};
}
