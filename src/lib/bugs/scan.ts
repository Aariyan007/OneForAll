import { createHash } from "node:crypto";

// Pure parts of the repository bug scan: which files are worth scanning, how they are batched for the token budget,
// how a finding is de-duplicated across scans, and whether a finding's evidence really is in the code it points at.

export type ScanFile = { path: string; language: string | null; sizeBytes: number; hasText: boolean; symbols: number; inDegree: number };
export type SkipReason = "no_text" | "not_source" | "generated" | "too_large" | "over_file_cap";
// One piece of the scan: a whole file, or part `part` of `parts` equal line ranges of a large file (15 lines of overlap).
export type ScanUnit = { path: string; part?: number; parts?: number };
export type ScanPlan = {
  batches: { units: ScanUnit[] }[];
  skipped: { path: string; reason: SkipReason }[];
  filesTotal: number;
  filesPlanned: number;
};
export type ScanOptions = { maxFiles: number; maxUnits: number; maxFileBytes: number; chunkBytes: number; batchBytes: number; maxFilesPerBatch: number };

export const DEFAULT_SCAN_OPTIONS: ScanOptions = { maxFiles: 40, maxUnits: 60, maxFileBytes: 160_000, chunkBytes: 32_000, batchBytes: 40_000, maxFilesPerBatch: 4 };

const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|java|go|rb|php|cs|rs|kt|swift|sql|sh)$/i;
const CONFIG_NAMES = /(?:^|\/)(?:package\.json|next\.config\.[cm]?[jt]s|middleware\.[jt]s|Dockerfile|docker-compose\.ya?ml|\.env\.example)$/;
const GENERATED = /(?:^|\/)(?:node_modules|dist|build|out|\.next|vendor|coverage|__pycache__|\.venv|generated)\/|\.min\.[cm]?js$|\.d\.ts$|\.map$|(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|spec)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/;

export function isTestPath(path: string): boolean {
  return TEST_FILE.test(path);
}

// Hubs first (many importers, many symbols), tests last: the budget goes to the code that most of the project depends on.
function priority(file: ScanFile): number {
  return file.inDegree * 3 + Math.min(file.symbols, 60) / 10 + (isTestPath(file.path) ? -5 : 0) + (CONFIG_NAMES.test(file.path) ? 1 : 0);
}

export function planScan(files: readonly ScanFile[], options: ScanOptions = DEFAULT_SCAN_OPTIONS): ScanPlan {
  const skipped: ScanPlan["skipped"] = [];
  const candidates: ScanFile[] = [];
  for (const file of files) {
    if (!file.hasText) skipped.push({ path: file.path, reason: "no_text" });
    else if (GENERATED.test(file.path)) skipped.push({ path: file.path, reason: "generated" });
    else if (!SOURCE_EXT.test(file.path) && !CONFIG_NAMES.test(file.path)) skipped.push({ path: file.path, reason: "not_source" });
    else if (file.sizeBytes > options.maxFileBytes) skipped.push({ path: file.path, reason: "too_large" });
    else candidates.push(file);
  }
  candidates.sort((a, b) => priority(b) - priority(a) || a.path.localeCompare(b.path));

  // Large files are split into line ranges so the biggest, most important files are scanned instead of skipped.
  const units: { unit: ScanUnit; bytes: number }[] = [];
  let planned = 0;
  for (const file of candidates) {
    const parts = Math.max(1, Math.ceil(file.sizeBytes / options.chunkBytes));
    if (planned >= options.maxFiles || units.length + parts > options.maxUnits) {
      skipped.push({ path: file.path, reason: "over_file_cap" });
      continue;
    }
    planned++;
    for (let part = 1; part <= parts; part++) {
      units.push({ unit: parts === 1 ? { path: file.path } : { path: file.path, part, parts }, bytes: Math.ceil(file.sizeBytes / parts) });
    }
  }

  const batches: { units: ScanUnit[]; bytes: number }[] = [];
  let current: { units: ScanUnit[]; bytes: number } | null = null;
  for (const { unit, bytes } of units) {
    if (!current || current.units.length >= options.maxFilesPerBatch || current.bytes + bytes > options.batchBytes) {
      current = { units: [], bytes: 0 };
      batches.push(current);
    }
    current.units.push(unit);
    current.bytes += bytes;
  }
  return { batches: batches.map((b) => ({ units: b.units })), skipped, filesTotal: files.length, filesPlanned: planned };
}

// Line range (1-based, inclusive) of one unit of a file with `total` lines.
export function unitRange(unit: ScanUnit, total: number): { start: number; end: number } {
  if (!unit.parts || unit.parts <= 1 || !unit.part) return { start: 1, end: total };
  const size = Math.ceil(total / unit.parts);
  const start = unit.part === 1 ? 1 : (unit.part - 1) * size + 1 - 15;
  return { start: Math.max(1, start), end: Math.min(total, unit.part * size) };
}

const squash = (text: string) => text.replace(/\s+/g, " ").trim();

// Drops the "12| " line numbers an excerpt carries, so a quote copied from it compares with the raw file.
function stripLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*\d+\|\s?/, ""))
    .join("\n");
}

export function normalizeEvidence(evidence: string): string {
  return squash(stripLineNumbers(evidence));
}

// A finding is kept only when the code it quotes is really at (or within 3 lines of) the lines it points to.
export function verifyEvidence(evidence: string, fileText: string, startLine: number, endLine: number): boolean {
  const needle = normalizeEvidence(evidence);
  if (needle.length < 4) return false;
  const lines = fileText.split("\n");
  const window = squash(lines.slice(Math.max(0, startLine - 4), Math.min(lines.length, endLine + 3)).join("\n"));
  return window.includes(needle);
}

// Stable across rescans and small line shifts: identifies a bug by the file and the code it quotes, not by its wording.
export function bugFingerprint(path: string, evidence: string): string {
  return createHash("sha256").update(`${path}\u0000${normalizeEvidence(evidence).slice(0, 200).toLowerCase()}`).digest("hex").slice(0, 40);
}
