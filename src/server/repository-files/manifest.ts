import { createHash } from "node:crypto";

// Pure helpers for building a repository file manifest. No database, no filesystem, no network, and
// nothing here reads or stores file contents beyond hashing the bytes it is handed. A future ingestion
// adapter hands in (path, content-or-hash) entries; this module decides what is safe and what to record.

export const MAX_PATH_LENGTH = 1024;

// Ingestion/manifest filtering only: these directories are never recorded. Nothing is deleted from any
// repository. Kept as a plain list so the rules can evolve in one place.
// Mirrored in the database (private.manifest_payload_check, migration 20261019000001): change both together.
export const IGNORED_DIRECTORIES = ["node_modules", ".git", "dist", "build", ".next", "coverage"] as const;

// Language is inferred from the file extension alone. It is metadata, not parsing and not a claim of
// language support: `.h` is reported as C even though it may be C++, and unknown extensions are NULL.
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "TypeScript", tsx: "TypeScript", mts: "TypeScript", cts: "TypeScript",
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript",
  py: "Python",
  java: "Java",
  c: "C", h: "C",
  cc: "C++", cpp: "C++", cxx: "C++", hpp: "C++", hh: "C++", hxx: "C++",
  cs: "C#",
  go: "Go",
  html: "HTML", htm: "HTML",
  css: "CSS",
  sql: "SQL",
  json: "JSON",
  yaml: "YAML", yml: "YAML",
  md: "Markdown", markdown: "Markdown",
};

export type PathResult = { ok: true; path: string } | { ok: false; error: string };

// Normalizes a repository-relative path: backslashes become '/', duplicate slashes and "." segments are
// removed. Anything unsafe is rejected rather than "fixed": absolute paths, drive letters, ".." segments
// (path traversal), control characters, and empty or oversized paths.
export function normalizeRepositoryPath(raw: unknown): PathResult {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, error: "Path is required." };
  if (/[\u0000-\u001f\u007f]/.test(raw)) return { ok: false, error: "Path contains control characters." };

  const unified = raw.replace(/\\/g, "/");
  if (unified.startsWith("/")) return { ok: false, error: "Absolute paths are not allowed." };
  if (/^[A-Za-z]:/.test(unified)) return { ok: false, error: "Drive-letter paths are not allowed." };

  const segments: string[] = [];
  for (const segment of unified.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return { ok: false, error: "Path traversal ('..') is not allowed." };
    segments.push(segment);
  }
  if (segments.length === 0) return { ok: false, error: "Path is empty." };

  const path = segments.join("/");
  if (path.length > MAX_PATH_LENGTH) return { ok: false, error: `Path is longer than ${MAX_PATH_LENGTH} characters.` };
  return { ok: true, path };
}

// True when any directory component of a normalized path is an ignored directory.
export function isIgnoredPath(path: string): boolean {
  const directories = path.split("/").slice(0, -1);
  return directories.some((segment) => (IGNORED_DIRECTORIES as readonly string[]).includes(segment));
}

export function detectLanguage(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile such as ".gitignore"
  return LANGUAGE_BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? null;
}

export function sha256Hex(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

export type ManifestInput =
  | { path: string; content: string | Uint8Array }
  | { path: string; sizeBytes: number; contentHash: string };

export type ManifestEntry = { path: string; language: string | null; sizeBytes: number; contentHash: string };
export type PreparedManifest = {
  entries: ManifestEntry[];
  skipped: { path: string; reason: string }[];
  rejected: { path: string; error: string }[];
};

// Turns controlled input into manifest entries. Content is hashed (SHA-256) and measured, never kept.
// Ignored directories are skipped; unsafe paths, bad hashes, bad sizes and duplicate paths are rejected,
// and the caller must refuse to ingest anything when `rejected` is non-empty (fail closed).
export function prepareManifest(inputs: readonly ManifestInput[]): PreparedManifest {
  const entries: ManifestEntry[] = [];
  const skipped: PreparedManifest["skipped"] = [];
  const rejected: PreparedManifest["rejected"] = [];
  const seen = new Set<string>();

  for (const input of inputs) {
    const normalized = normalizeRepositoryPath(input.path);
    if (!normalized.ok) {
      rejected.push({ path: String(input.path).slice(0, 200), error: normalized.error });
      continue;
    }
    const { path } = normalized;
    if (isIgnoredPath(path)) {
      skipped.push({ path, reason: "ignored directory" });
      continue;
    }
    if (seen.has(path)) {
      rejected.push({ path, error: "Duplicate path in manifest." });
      continue;
    }

    let sizeBytes: number;
    let contentHash: string;
    if ("content" in input) {
      contentHash = sha256Hex(input.content);
      sizeBytes = typeof input.content === "string" ? Buffer.byteLength(input.content, "utf8") : input.content.byteLength;
    } else {
      if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
        rejected.push({ path, error: "Size must be a non-negative integer." });
        continue;
      }
      if (!SHA256_HEX.test(input.contentHash)) {
        rejected.push({ path, error: "Content hash must be a lowercase SHA-256 hex digest." });
        continue;
      }
      sizeBytes = input.sizeBytes;
      contentHash = input.contentHash;
    }

    seen.add(path);
    entries.push({ path, language: detectLanguage(path), sizeBytes, contentHash });
  }
  return { entries, skipped, rejected };
}
