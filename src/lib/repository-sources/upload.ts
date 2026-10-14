// Upload-selection rules shared by the upload form (immediate feedback, disabled submit) and the server action
// (authoritative re-check). Pure and client-safe: no I/O, no secrets. The maximum size always comes from the server
// (ARCHIVE_LIMITS.maxUploadBytes); this module never hard-codes it.

export type SelectedFile = { name: string; size: number };

export type SelectionResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "extension" | "empty" | "too-large"; message: string };

// Binary units, labelled as such (1 MiB = 1,048,576 bytes), matching how the limits are defined.
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

export function validateArchiveSelection(file: SelectedFile | null, maxBytes: number): SelectionResult {
  if (file === null) return { ok: false, reason: "missing", message: "Choose a .zip archive to upload." };
  if (!file.name.toLowerCase().endsWith(".zip")) {
    return { ok: false, reason: "extension", message: "Only .zip archives are supported. Choose a file that ends in .zip." };
  }
  if (file.size === 0) return { ok: false, reason: "empty", message: "This file is empty. Choose the .zip archive of your source code." };
  if (file.size > maxBytes) {
    return {
      ok: false,
      reason: "too-large",
      message: `This archive is ${formatBytes(file.size)}, over the ${formatBytes(maxBytes)} limit.`,
    };
  }
  return { ok: true };
}

// How to make a smaller archive, shown when a file is over the limit.
export const SMALLER_ARCHIVE_TIPS = [
  "Archive only the source: leave out node_modules, .git, dist, build, .next, coverage and other generated folders.",
  "Leave out large assets such as images, videos, datasets and binaries; they are not analysed.",
  "From a Git checkout, `git archive --format=zip -o source.zip HEAD` includes only committed files.",
] as const;
