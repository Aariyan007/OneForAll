import { createHmac } from "node:crypto";

// Canonical form and HMAC-SHA256 signature of a snapshot manifest persistence request. Pure (no environment, no
// secret of its own): the key is passed in by the caller, which reads the server-only STRUCTURE_PERSIST_KEY (the same
// key that signs structure; the version line keeps the two kinds of message apart). The database verifies the same
// message with the key held in Supabase Vault (private.manifest_canonical + persist_snapshot_manifest, migration
// 20261018000001; version 2 since 20261021000001), so both sides MUST stay identical. A fixed test vector in
// supabase/tests/repository_manifest_lifecycle_rls.sql keeps them in agreement.
//
// CANONICAL MESSAGE, version 2 (UTF-8, every line ends with LF):
//   OFA-MANIFEST-V2
//   <snapshot_id, lowercase uuid>
//   <run_token, 64 lowercase hex>
//   SRC|<source_kind>|<archive_format>|<archive_sha256>|<archive_bytes>|<archive_commit or ->|<entries_total>|<files_accepted>|<files_skipped>|<files_skipped_oversized>|<files_skipped_generated>|<files_skipped_metadata>|<files_skipped_sensitive or ->
//   <number of files>
//   one line per file, in array order:
//     F|<S path>|<S language>|<size_bytes>|<content_hash>
// where <S x> is "-" for null, otherwise "<UTF-8 byte length>:<x>", so a value containing "|" or a newline can never
// move a field boundary. Integers are plain decimal. The signature is the lowercase hex HMAC-SHA256.

// Field names match the database payload (p_source / p_files) exactly.
export type ManifestSource = {
  // UPLOADED_ARCHIVE: a ZIP uploaded by a user. GITHUB_ARCHIVE: fetched by the server from GitHub for an exact commit.
  source_kind: "UPLOADED_ARCHIVE" | "GITHUB_ARCHIVE";
  archive_format: "ZIP";
  archive_sha256: string;
  archive_bytes: number;
  archive_commit: string | null;
  entries_total: number;
  files_accepted: number;
  files_skipped: number;
  files_skipped_oversized: number;
  files_skipped_generated: number;
  files_skipped_metadata: number;
  files_skipped_sensitive: number;
};

export type ManifestFile = { path: string; language: string | null; size_bytes: number; content_hash: string };

export type ManifestSigningInput = {
  snapshotId: string;
  runToken: string;
  source: ManifestSource;
  files: readonly ManifestFile[];
};

function lengthPrefixed(value: string | null): string {
  return value === null ? "-" : `${Buffer.byteLength(value, "utf8")}:${value}`;
}

export function canonicalManifest(input: ManifestSigningInput): string {
  const s = input.source;
  const lines = [
    "OFA-MANIFEST-V2",
    input.snapshotId.toLowerCase(),
    input.runToken,
    `SRC|${s.source_kind}|${s.archive_format}|${s.archive_sha256}|${s.archive_bytes}|${s.archive_commit ?? "-"}` +
      `|${s.entries_total}|${s.files_accepted}|${s.files_skipped}` +
      `|${s.files_skipped_oversized}|${s.files_skipped_generated}|${s.files_skipped_metadata}|${s.files_skipped_sensitive}`,
    String(input.files.length),
    ...input.files.map((f) => `F|${lengthPrefixed(f.path)}|${lengthPrefixed(f.language)}|${f.size_bytes}|${f.content_hash}`),
  ];
  return lines.join("\n") + "\n";
}

export function signManifest(key: string, input: ManifestSigningInput): string {
  return createHmac("sha256", key).update(canonicalManifest(input), "utf8").digest("hex");
}
