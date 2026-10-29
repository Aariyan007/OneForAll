import "server-only";
import { createClient } from "@/lib/supabase/server";
import { validateArchiveSelection } from "@/lib/repository-sources/upload";
import { persistSnapshotManifest } from "@/server/repository-files/ingest";
import { GENERIC_MESSAGE, PERMISSION_MESSAGE } from "@/server/requirements/errors";
import type { SnapshotStatus } from "@/server/repository-snapshots/schema";
import { KEY_MISSING_MESSAGE, getStructurePersistKey } from "@/server/repository-structure/persist-key";
import { getAnalysisReadiness } from "@/server/repository-structure/readiness";
import { analyzeSnapshot } from "@/server/repository-structure/run";
import type { SourceFile } from "@/server/repository-structure/source";
import { type SourceArchive, countExclusions, matchesManifest, readSourceArchive } from "./archive";
import { contentBatches, decodeStorableText } from "./contents";
import { storeFileEdges } from "./file-edges";
import { ARCHIVE_LIMITS, STALE_PROCESSING_MILLIS } from "./limits";
import { createArchiveSourceProvider } from "./provider";
import { ArchiveError } from "./zip";

// Archive-based source ingestion for ONE snapshot. INTERNAL and server-only (not a Server Action): the caller has
// already verified the session and the organization -> department -> team -> project -> repository chain, and passes
// the repository id it resolved from the database. Everything below runs as the signed-in user; the code never uses a
// service role. Clients cannot write a snapshot's lifecycle, manifest or source record directly (migration
// 20261018000001): every write goes through the database functions below, which re-check OWNER/ADMIN themselves.
//
//   PENDING | FAILED                                     nothing is written until the archive is fully validated
//     -> PROCESSING      begin_snapshot_ingestion: exactly one request wins (row lock); it gets a one-time run token
//     -> COMPLETED       persist_snapshot_manifest: run token + HMAC signature verified, then source record, the whole
//                        manifest and COMPLETED in one transaction (snapshot COMPLETED = source manifest recorded)
//     -> structure analysis (existing signed pipeline), its status is kept separately on the analysis
//   any failure after PROCESSING -> FAILED (fail_snapshot_ingestion, needs the run token) with a safe message and
//   nothing partial left behind; retry by uploading again.
//
// The archive bytes live only in this request's memory and are dropped when it ends. Re-analysing a COMPLETED
// snapshot needs an upload whose files match the recorded manifest exactly.
//
// After the manifest is recorded, the text of its files is stored (store_snapshot_contents, migration 20261028000002):
// the database accepts only the exact bytes the sealed manifest hashed. Storing is best effort and idempotent: a
// failure leaves the snapshot COMPLETED, and uploading the same archive again fills in what is missing (this is also
// how snapshots recorded before the content store get their text).

// `changed` is true when the database was written (the snapshot moved to FAILED); validation errors write nothing.
export type IngestionResult =
  | { ok: false; error: string; changed?: true }
  | { ok: true; message: string; analysisError?: string };

const PAGE_SIZE = 1000;

type Snapshot = { id: string; status: SnapshotStatus; commit_sha: string; started_at: string | null };

async function readSnapshot(snapshotId: string, repositoryId: string): Promise<Snapshot | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("repository_snapshots")
    .select("id, status, commit_sha, started_at")
    .eq("id", snapshotId)
    .eq("repository_id", repositoryId)
    .maybeSingle();
  return (data as Snapshot | null) ?? null;
}

const DUPLICATE_COMMIT_MESSAGE = "A completed snapshot of this commit already exists for this repository.";
const BUSY_MESSAGE = "This snapshot is already being processed.";

// PENDING | FAILED -> PROCESSING. The database locks the snapshot row, so exactly one concurrent request wins; it also
// refuses a commit that already has a COMPLETED snapshot in this repository (one is allowed) before writing anything.
async function beginIngestion(snapshotId: string): Promise<{ ok: true; runToken: string } | { ok: false; error: string }> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("begin_snapshot_ingestion", { p_snapshot_id: snapshotId });
  if (error) {
    if (error.code === "23505") return { ok: false, error: DUPLICATE_COMMIT_MESSAGE };
    if (error.code === "55000" && error.message.includes("already being processed")) return { ok: false, error: BUSY_MESSAGE };
    if (error.code === "55000") return { ok: false, error: "This snapshot changed while you were uploading. Reload and try again." };
    return { ok: false, error: PERMISSION_MESSAGE };
  }
  const run = data[0];
  return run ? { ok: true, runToken: run.run_token } : { ok: false, error: GENERIC_MESSAGE };
}

// PROCESSING -> FAILED for this attempt (its run token), clearing anything it recorded.
async function failIngestion(snapshotId: string, runToken: string, message: string): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc("fail_snapshot_ingestion", {
    p_snapshot_id: snapshotId,
    p_run_token: runToken,
    p_error_message: message,
  });
  return !error;
}

async function loadRecordedManifest(snapshotId: string): Promise<SourceFile[]> {
  const supabase = await createClient();
  const files: SourceFile[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("repository_files")
      .select("id, path, language, size_bytes, content_hash")
      .eq("snapshot_id", snapshotId)
      .order("path")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error("manifest read failed");
    for (const row of data) {
      files.push({ id: row.id, path: row.path, language: row.language, sizeBytes: row.size_bytes, contentHash: row.content_hash });
    }
    if (data.length < PAGE_SIZE) return files;
  }
}

// An archive fetched by the server itself (GitHub import): the bytes plus where they came from. It goes through exactly
// the same reader, limits, exclusions, signing and persistence as an upload.
export type FetchedArchive = { kind: "GITHUB_ARCHIVE"; bytes: Buffer };

function isFetchedArchive(value: unknown): value is FetchedArchive {
  return typeof value === "object" && value !== null && (value as FetchedArchive).kind === "GITHUB_ARCHIVE" && Buffer.isBuffer((value as FetchedArchive).bytes);
}

async function readUpload(upload: unknown): Promise<SourceArchive> {
  if (isFetchedArchive(upload)) {
    if (upload.bytes.length > ARCHIVE_LIMITS.maxUploadBytes) throw new ArchiveError("The repository archive is larger than the size limit.");
    return readSourceArchive(upload.bytes, ARCHIVE_LIMITS);
  }
  if (!(upload instanceof File)) throw new ArchiveError("Choose a .zip archive to upload.");
  // Same rules (and messages) as the form; here they are authoritative. The declared size is only a first check: the
  // reader checks the real byte count again.
  const selection = validateArchiveSelection({ name: upload.name, size: upload.size }, ARCHIVE_LIMITS.maxUploadBytes);
  if (!selection.ok) throw new ArchiveError(selection.message);
  return readSourceArchive(Buffer.from(await upload.arrayBuffer()), ARCHIVE_LIMITS);
}

// Stores the text files of a COMPLETED snapshot in batches. Returns how many files have stored text afterwards, or
// null when a batch was refused (the files stored by earlier batches stay; storing again is safe).
async function storeContents(snapshotId: string, archive: SourceArchive): Promise<number | null> {
  const { batches } = contentBatches(
    archive.manifest.map((entry) => entry.path),
    archive.contents,
  );
  const supabase = await createClient();
  let total = 0;
  for (const batch of batches) {
    const { data, error } = await supabase.rpc("store_snapshot_contents", { p_snapshot_id: snapshotId, p_files: batch });
    if (error || !data[0]) return null;
    total += data[0].stored + data[0].already_stored;
  }
  return total;
}

// Import edges between the files of the snapshot (the dependency part of the project graph). Best effort: a failure
// leaves the snapshot and its symbol graph intact and can be repaired with "Rebuild links" on the project graph page.
async function storeEdges(snapshotId: string, archive: SourceArchive): Promise<void> {
  const files: { path: string; content: string }[] = [];
  for (const entry of archive.manifest) {
    const bytes = archive.contents.get(entry.path);
    const text = bytes ? decodeStorableText(bytes) : null;
    if (text !== null) files.push({ path: entry.path, content: text });
  }
  await storeFileEdges(snapshotId, files).catch(() => null);
}

function contentsMessage(stored: number | null): string {
  return stored === null
    ? "The source text could not be stored for the AI assistant; upload the same archive again to retry."
    : `Stored the text of ${stored} files for the AI assistant.`;
}

// Runs the structure analysis with a provider bound to this snapshot's recorded manifest and the upload's bytes.
async function analyse(snapshotId: string, repositoryId: string, archive: SourceArchive): Promise<string | undefined> {
  const manifest = await loadRecordedManifest(snapshotId);
  const provider = createArchiveSourceProvider(manifest, archive.contents);
  const readiness = getAnalysisReadiness(provider);
  if (!readiness.ready) return readiness.message;
  const outcome = await analyzeSnapshot(snapshotId, repositoryId, provider);
  // A recorded failure is shown from the analysis row (FAILED + message); an unrecorded one is reported here.
  if (!outcome.ok) return outcome.recorded ? "Structure analysis failed. See the analysis status for details." : outcome.error;
  return undefined;
}

export async function ingestSnapshotArchive(repositoryId: string, snapshotId: string, upload: unknown): Promise<IngestionResult> {
  const sourceKind = isFetchedArchive(upload) ? upload.kind : "UPLOADED_ARCHIVE";
  const snapshot = await readSnapshot(snapshotId, repositoryId);
  if (!snapshot) return { ok: false, error: PERMISSION_MESSAGE };
  if (snapshot.status === "PROCESSING") return { ok: false, error: BUSY_MESSAGE };
  // A completed analysis is immutable; only a missing, pending or failed one can be (re-)run. A matching upload for an
  // already analysed snapshot still stores any source text that is missing.
  let analysedAlready = false;
  if (snapshot.status === "COMPLETED") {
    const supabase = await createClient();
    const { data: analysis, error } = await supabase
      .from("repository_structure_analyses")
      .select("status")
      .eq("snapshot_id", snapshot.id)
      .maybeSingle();
    if (error) return { ok: false, error: GENERIC_MESSAGE };
    if (analysis?.status === "PROCESSING") return { ok: false, error: "An analysis is already in progress." };
    analysedAlready = analysis?.status === "COMPLETED";
  }

  // 1. Validate the whole upload before touching the snapshot. An invalid archive leaves everything unchanged.
  let archive: SourceArchive;
  try {
    archive = await readUpload(upload);
  } catch (error) {
    return { ok: false, error: error instanceof ArchiveError ? error.message : "The archive could not be read." };
  }
  if (archive.archiveCommit !== null && archive.archiveCommit !== snapshot.commit_sha) {
    return {
      ok: false,
      error: `The archive says it was made from commit ${archive.archiveCommit.slice(0, 12)}, but this snapshot is for ${snapshot.commit_sha.slice(0, 12)}.`,
    };
  }

  // 2a. COMPLETED snapshot: the manifest is sealed. Only (re-)run the analysis, and only with identical files.
  if (snapshot.status === "COMPLETED") {
    let recorded: SourceFile[];
    try {
      recorded = await loadRecordedManifest(snapshot.id);
    } catch {
      return { ok: false, error: GENERIC_MESSAGE };
    }
    if (!matchesManifest(archive, recorded)) {
      return { ok: false, error: "The archive does not match the files recorded for this snapshot, so it cannot be used to analyse it." };
    }
    const stored = await storeContents(snapshot.id, archive);
    await storeEdges(snapshot.id, archive);
    if (analysedAlready) return { ok: true, message: `Source matched the recorded manifest. ${contentsMessage(stored)}` };
    const analysisError = await analyse(snapshot.id, repositoryId, archive);
    return { ok: true, message: `Source matched the recorded manifest; structure analysis ran. ${contentsMessage(stored)}`, analysisError };
  }

  // The manifest is signed with the server-only key; without it nothing can be recorded, so refuse before writing.
  if (!getStructurePersistKey()) return { ok: false, error: KEY_MISSING_MESSAGE };

  // 3. PENDING | FAILED -> PROCESSING (a FAILED snapshot is retried; the earlier attempt's rows are cleared).
  const begun = await beginIngestion(snapshot.id);
  if (!begun.ok) return { ok: false, error: begun.error };

  // 4. Record source + manifest + COMPLETED atomically. Any failure leaves a visible FAILED snapshot with nothing
  //    partial recorded, which can be retried.
  const fail = async (message: string) => {
    await failIngestion(snapshot.id, begun.runToken, message);
    return { ok: false as const, error: message, changed: true as const };
  };
  try {
    const exclusions = countExclusions(archive.skipped);
    const persisted = await persistSnapshotManifest(
      snapshot.id,
      begun.runToken,
      {
        source_kind: sourceKind,
        archive_format: "ZIP",
        archive_sha256: archive.archiveSha256,
        archive_bytes: archive.archiveBytes,
        archive_commit: archive.archiveCommit,
        entries_total: archive.entriesTotal,
        files_skipped: archive.skipped.length,
        files_skipped_oversized: exclusions.oversized,
        files_skipped_generated: exclusions.generated,
        files_skipped_metadata: exclusions.metadata,
        files_skipped_sensitive: exclusions.sensitive,
      },
      archive.manifest.map((entry) => ({ path: entry.path, sizeBytes: entry.sizeBytes, contentHash: entry.contentHash })),
    );
    if (!persisted.ok || persisted.inserted !== archive.manifest.length) {
      // 23505: another snapshot of this commit completed meanwhile (begin's check cannot exclude a race).
      return await fail(!persisted.ok && persisted.code === "23505" ? DUPLICATE_COMMIT_MESSAGE : "Could not record the file manifest. Try again.");
    }
  } catch {
    return await fail("Processing the archive failed. Try again.");
  }

  // 5. Source text for later reading (best effort, see above), then structure analysis (separate status). A failure
  //    in either does not undo the recorded manifest.
  const stored = await storeContents(snapshot.id, archive);
  await storeEdges(snapshot.id, archive);
  const analysisError = await analyse(snapshot.id, repositoryId, archive);
  return { ok: true, message: `${summarize(archive)} ${contentsMessage(stored)}`, analysisError };
}

// Result line for the uploader: what was recorded and what was left out (and why). Paths are the user's own archive.
function summarize(archive: SourceArchive): string {
  const counts = countExclusions(archive.skipped);
  const parts = [`Recorded ${archive.manifest.length} files from the archive.`];
  const left: string[] = [];
  if (counts.oversized) left.push(`${counts.oversized} over the per-file size limit`);
  if (counts.generated) left.push(`${counts.generated} in generated or dependency folders`);
  if (counts.metadata) left.push(`${counts.metadata} archive metadata`);
  if (counts.sensitive) left.push(`${counts.sensitive} that may contain credentials`);
  if (left.length > 0) parts.push(`Not recorded: ${left.join(", ")}.`);
  const big = archive.skipped.filter((s) => s.category === "oversized").map((s) => s.path);
  if (big.length > 0) parts.push(`Too large: ${big.slice(0, 10).join(", ")}${big.length > 10 ? ` and ${big.length - 10} more` : ""}.`);
  return parts.join(" ");
}

// Crash/disconnect recovery: a snapshot stuck in PROCESSING for longer than STALE_PROCESSING_MILLIS can be marked
// FAILED without the (lost) run token. The database enforces the same 10-minute threshold itself.
export async function failStaleSnapshot(repositoryId: string, snapshotId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const snapshot = await readSnapshot(snapshotId, repositoryId);
  if (!snapshot) return { ok: false, error: PERMISSION_MESSAGE };
  if (snapshot.status !== "PROCESSING") return { ok: false, error: "Only a snapshot that is processing can be marked as failed." };
  const started = snapshot.started_at ? Date.parse(snapshot.started_at) : 0;
  if (Date.now() - started < STALE_PROCESSING_MILLIS) {
    return { ok: false, error: "This snapshot started processing recently. Wait before marking it as failed." };
  }
  const supabase = await createClient();
  const { error } = await supabase.rpc("fail_stale_snapshot_ingestion", { p_snapshot_id: snapshot.id });
  if (!error) return { ok: true };
  if (error.code === "55000") return { ok: false, error: "This snapshot is no longer stuck. Reload the page." };
  return { ok: false, error: PERMISSION_MESSAGE };
}
