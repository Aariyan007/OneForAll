// Pure helpers behind the full-page navigation that follows a Server Action (src/components/ui/reload.ts).
// No "@/" imports and no browser globals: the tests run under plain Node (node:test).

// The path (with query and hash) when `href` is a same-origin path, otherwise null. Only paths starting with a single
// "/" are accepted: absolute URLs, protocol-relative "//host" and "/\host" (which browsers treat as "//host") are
// refused, so a returned value can never take the browser to another site.
export function sameOriginPath(href: string | null | undefined, origin: string): string | null {
  if (typeof href !== "string" || !href.startsWith("/") || href.startsWith("//") || href.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(href, origin);
  } catch {
    return null;
  }
  if (url.origin !== new URL(origin).origin) return null;
  return url.pathname + url.search + url.hash;
}

export type PageNoticeTone = "success" | "warning" | "danger";
export type PageNoticeData = { tone: PageNoticeTone; title?: string; message: string };
export type StoredPageNotice = PageNoticeData & { path: string };

const TONES: readonly string[] = ["success", "warning", "danger"];
const MAX_TEXT = 500;

// A stored notice, or null when the value is missing, malformed or saved for a different path. Only plain text fields
// are kept (rendered as React text, never as HTML).
export function parseStoredNotice(raw: string | null, pathname: string): PageNoticeData | null {
  if (!raw) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.path !== "string" || v.path !== pathname) return null;
  if (typeof v.message !== "string" || v.message.length === 0 || v.message.length > MAX_TEXT) return null;
  if (typeof v.tone !== "string" || !TONES.includes(v.tone)) return null;
  if (v.title !== undefined && (typeof v.title !== "string" || v.title.length > MAX_TEXT)) return null;
  return { tone: v.tone as PageNoticeTone, message: v.message, ...(typeof v.title === "string" ? { title: v.title } : {}) };
}
