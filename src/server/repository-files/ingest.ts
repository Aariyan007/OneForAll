import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { KEY_MISSING_MESSAGE, getStructurePersistKey } from "@/server/repository-structure/persist-key";
import { type ManifestInput, prepareManifest } from "./manifest";
import { type ManifestFile, type ManifestSource, signManifest } from "./signing";

// Internal manifest persistence for a server-side ingestion (archive upload today). It is deliberately NOT a Server
// Action ("use server"): the browser can never call it and never supplies a manifest. Clients have no INSERT/DELETE
// privilege on repository_files (migration 20261018000001): the manifest is written only by
// persist_snapshot_manifest(), which requires this ingestion's one-time run token (from begin_snapshot_ingestion)
// and an HMAC signature made with the server-only key, and which records the source, the whole manifest and the
// COMPLETED status in one transaction. Nothing is stored but path, language, size and hash.

export const MAX_FILES_PER_INGEST = 5000;

export type PersistManifestResult =
  | { ok: true; inserted: number }
  | { ok: false; error: string; code?: string; rejected?: { path: string; error: string }[] };

export async function persistSnapshotManifest(
  snapshotId: string,
  runToken: string,
  source: Omit<ManifestSource, "files_accepted">,
  inputs: readonly ManifestInput[],
): Promise<PersistManifestResult> {
  await requireUser();

  if (!idSchema.safeParse(snapshotId).success) return { ok: false, error: "Invalid snapshot." };
  if (inputs.length === 0) return { ok: false, error: "The manifest is empty." };
  if (inputs.length > MAX_FILES_PER_INGEST) return { ok: false, error: `At most ${MAX_FILES_PER_INGEST} files per ingest.` };

  const { entries, rejected } = prepareManifest(inputs);
  // Fail closed: one unsafe or malformed entry rejects the whole batch, and nothing may be silently dropped.
  if (rejected.length > 0) return { ok: false, error: "The manifest contains invalid entries.", rejected };
  if (entries.length !== inputs.length) return { ok: false, error: "The manifest contains files that cannot be recorded." };

  const key = getStructurePersistKey();
  if (!key) return { ok: false, error: KEY_MISSING_MESSAGE };

  const files: ManifestFile[] = entries.map((entry) => ({
    path: entry.path,
    language: entry.language,
    size_bytes: entry.sizeBytes,
    content_hash: entry.contentHash,
  }));
  const fullSource: ManifestSource = { ...source, files_accepted: files.length };
  const signature = signManifest(key, { snapshotId, runToken, source: fullSource, files });

  // One RPC = one transaction: verify token + signature + invariants, record source and manifest, complete the
  // snapshot, consume the token. On any error nothing is written.
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("persist_snapshot_manifest", {
    p_snapshot_id: snapshotId,
    p_run_token: runToken,
    p_source: fullSource,
    p_files: files,
    p_signature: signature,
  });
  if (error) {
    if (error.code === "42501") return { ok: false, error: "You cannot add files to this snapshot.", code: error.code };
    if (error.code === "23505") return { ok: false, error: "A completed snapshot of this commit already exists.", code: error.code };
    return { ok: false, error: "Could not record the manifest.", code: error.code };
  }
  const persisted = data[0];
  if (!persisted || persisted.status !== "COMPLETED") return { ok: false, error: "Could not record the manifest." };
  return { ok: true, inserted: persisted.files_count };
}
