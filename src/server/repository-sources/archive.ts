import { createHash } from "node:crypto";
// Relative imports (not "@/"): keeps these pure modules runnable by the plain-Node tests.
import { IGNORED_DIRECTORIES, type ManifestEntry, isIgnoredPath, normalizeRepositoryPath, prepareManifest } from "../repository-files/manifest";
import { formatBytes } from "../../lib/repository-sources/upload";
import type { ArchiveLimits } from "./limits";
import { ArchiveError, readZip } from "./zip";

// Uploaded ZIP -> safe source files -> manifest entries. Pure (no I/O). Every path goes through the existing manifest
// normalization; anything unsafe or ambiguous rejects the whole archive (fail closed). The manifest itself is built by
// the existing `prepareManifest`, so language detection, ignored directories and hashing stay in one place.

export type SourceArchive = {
  archiveSha256: string;
  archiveBytes: number;
  // Commit id the archive claims about itself (ZIP comment written by `git archive` and Git-host downloads). A claim,
  // never verification.
  archiveCommit: string | null;
  entriesTotal: number; // file entries in the archive (directories excluded)
  manifest: ManifestEntry[]; // accepted files, as they will be recorded
  skipped: SkippedFile[];
  contents: Map<string, Buffer>; // accepted path -> exact bytes (server memory only)
};

// Why a file in the archive was not recorded. Every skipped file has exactly one category, so the counts add up.
//   oversized: larger than the per-file limit (never decompressed, truncated or parsed)
//   generated: inside an ignored generated/dependency folder (node_modules, .git, dist, build, .next, coverage)
//   metadata:  archive-tool metadata (__MACOSX/)
//   sensitive: a file that commonly holds credentials (.env, private keys, .npmrc, ...): never hashed, recorded or parsed
export type SkipCategory = "oversized" | "generated" | "metadata" | "sensitive";
export type SkippedFile = { path: string; reason: string; category: SkipCategory };
export type ExclusionCounts = Record<SkipCategory, number>;

export function countExclusions(skipped: readonly SkippedFile[]): ExclusionCounts {
  const counts: ExclusionCounts = { oversized: 0, generated: 0, metadata: 0, sensitive: 0 };
  for (const file of skipped) counts[file.category]++;
  return counts;
}

const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
// Mirrored in the database (private.manifest_payload_check, migration 20261019000001): change both together.
const ARCHIVE_METADATA = "__MACOSX";

// Files that commonly contain credentials, matched by file name only. This is a safety net, not secret scanning: such
// files are counted as "sensitive" and never recorded, hashed or parsed (a hash of a low-entropy secret could be
// guessed offline). Mirrored in the database (private.manifest_payload_check, migration 20261021000001).
const SENSITIVE_NAMES = new Set([".npmrc", ".pypirc", ".netrc", ".git-credentials", ".htpasswd", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519"]);
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];
const ENV_TEMPLATES = new Set([".env.example", ".env.sample", ".env.template", ".env.dist"]);

export function isSensitivePath(path: string): boolean {
  const name = (path.split("/").pop() ?? path).toLowerCase();
  if (ENV_TEMPLATES.has(name)) return false;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (SENSITIVE_NAMES.has(name)) return true;
  return SENSITIVE_EXTENSIONS.some((extension) => name.endsWith(extension));
}

export function readSourceArchive(buf: Buffer, limits: ArchiveLimits, now?: () => number): SourceArchive {
  if (buf.length === 0) throw new ArchiveError("The uploaded file is empty.");
  if (buf.length > limits.maxUploadBytes) throw new ArchiveError("The archive is larger than the upload limit.");
  const zip = readZip(buf, limits, now);

  // 1. Normalize every path with the manifest rules (no absolute, drive-letter, "..", control characters, ...).
  const candidates: { path: string; size: number; data: Buffer | null }[] = [];
  for (const file of zip.files) {
    // The database path CHECK rejects every [:cntrl:] character, including C1 controls (U+0080-U+009F) that the
    // manifest normalizer lets through. Reject them here, before anything is written.
    if (/[\u0080-\u009f]/.test(file.name)) throw new ArchiveError("Unsafe path in the archive (Path contains control characters.)");
    const normalized = normalizeRepositoryPath(file.name);
    if (!normalized.ok) throw new ArchiveError(`Unsafe path in the archive (${normalized.error})`);
    candidates.push({ path: normalized.path, size: file.size, data: file.data });
  }

  // 2. One shared top-level folder (as in Git-host downloads, e.g. "repo-<sha>/") is the repository root: strip it.
  //    Never an ignored or metadata folder (an archive of only "node_modules/..." must not become source).
  const first = candidates[0]?.path.split("/")[0];
  const strippable = first !== undefined && first !== ARCHIVE_METADATA && !(IGNORED_DIRECTORIES as readonly string[]).includes(first);
  if (strippable && candidates.every((c) => c.path.startsWith(`${first}/`))) {
    for (const c of candidates) c.path = c.path.slice(first.length + 1);
  }

  // 3. Paths must be unambiguous on every platform: no exact, Unicode-normalization or case-insensitive collisions,
  //    and no path that is both a file and a directory.
  const keys = new Set<string>();
  const directories = new Set<string>();
  for (const c of candidates) {
    const key = c.path.normalize("NFC").toLowerCase();
    if (keys.has(key)) throw new ArchiveError(`The archive contains duplicate or colliding paths ("${c.path.slice(0, 120)}").`);
    keys.add(key);
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0, i).join("/"));
  }
  for (const key of keys) {
    if (directories.has(key)) throw new ArchiveError("The archive contains a path that is both a file and a folder.");
  }

  // 4. Skip what is not repository source; keep the exact bytes of everything else.
  const skipped: SourceArchive["skipped"] = [];
  const kept: { path: string; content: Buffer }[] = [];
  for (const c of candidates) {
    // One category per file, in this order: metadata, generated folder, sensitive, oversized.
    if (c.path === ARCHIVE_METADATA || c.path.startsWith(`${ARCHIVE_METADATA}/`)) {
      skipped.push({ path: c.path, reason: "archive metadata", category: "metadata" });
    } else if (isIgnoredPath(c.path)) {
      skipped.push({ path: c.path, reason: "ignored directory", category: "generated" });
    } else if (isSensitivePath(c.path)) {
      skipped.push({ path: c.path, reason: "may contain credentials", category: "sensitive" });
    } else if (c.data === null) {
      skipped.push({ path: c.path, reason: `larger than the ${formatBytes(limits.maxFileBytes)} per-file limit`, category: "oversized" });
    } else {
      kept.push({ path: c.path, content: c.data });
    }
  }

  // 5. The existing manifest rules decide the rest (ignored directories, duplicates, hashing, language).
  const prepared = prepareManifest(kept);
  if (prepared.rejected.length > 0) throw new ArchiveError("The archive contains entries that cannot be recorded safely.");
  // prepareManifest only skips files inside ignored (generated/dependency) directories.
  skipped.push(...prepared.skipped.map((s) => ({ path: s.path, reason: s.reason, category: "generated" as const })));
  if (prepared.entries.length === 0) throw new ArchiveError("The archive contains no files that can be recorded.");
  if (prepared.entries.length > limits.maxFiles) throw new ArchiveError(`The archive has more than ${limits.maxFiles} files.`);

  const accepted = new Set(prepared.entries.map((entry) => entry.path));
  const contents = new Map<string, Buffer>();
  for (const k of kept) if (accepted.has(k.path)) contents.set(k.path, k.content);

  const claimed = zip.comment.trim().toLowerCase();
  return {
    archiveSha256: createHash("sha256").update(buf).digest("hex"),
    archiveBytes: buf.length,
    archiveCommit: COMMIT.test(claimed) ? claimed : null,
    entriesTotal: candidates.length,
    manifest: [...prepared.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    skipped,
    contents,
  };
}

// True when the archive's files are exactly the recorded manifest (same paths, sizes and hashes). Used to re-supply
// source for analysing an already COMPLETED snapshot without changing its manifest.
export function matchesManifest(archive: SourceArchive, recorded: readonly { path: string; sizeBytes: number; contentHash: string }[]): boolean {
  if (archive.manifest.length !== recorded.length) return false;
  const byPath = new Map(archive.manifest.map((entry) => [entry.path, entry]));
  return recorded.every((r) => {
    const entry = byPath.get(r.path);
    return entry !== undefined && entry.sizeBytes === r.sizeBytes && entry.contentHash === r.contentHash;
  });
}
