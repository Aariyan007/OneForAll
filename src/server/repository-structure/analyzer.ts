import "server-only";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/server/auth/session";
import { idSchema } from "@/server/departments/schema";
import { sha256Hex } from "@/server/repository-files/manifest";
import { getParserAdapter } from "./parser-registry";
import { KEY_MISSING_MESSAGE, getStructurePersistKey } from "./persist-key";
import {
  type PersistedRelationship,
  type PersistedSymbol,
  persistedRelationshipSchema,
  persistedSymbolSchema,
} from "./schema";
import { signStructure } from "./signing";
import { type SourceFile, type SourceProvider, UNAVAILABLE_SOURCE_MESSAGE, getSourceProvider } from "./source";

// Structure-analysis orchestration. INTERNAL and server-only: it is NOT a Server Action, so the browser can never
// call it, never supplies source or paths, and cannot choose the provider. It is invoked by the `analyzeStructure`
// action (with the configured provider) and by server-side fixtures in tests.
//
//   begin_structure_analysis (PENDING -> PROCESSING, returns a random run token)
//   -> load manifest -> read source (verified against the manifest hash) -> detect language -> parser registry
//   -> normalized symbols/relationships -> validate -> HMAC-SHA256 sign (server-only STRUCTURE_PERSIST_KEY)
//   -> persist_structure_analysis (verifies token + signature, writes atomically) -> COMPLETED
//   any failure of the pipeline: fail_structure_analysis (-> FAILED; nothing partial is left behind)
//
// Clients can write neither the lifecycle nor the structure; only these SECURITY DEFINER functions can, each
// re-checking OWNER/ADMIN of the derived organization. The run token and signature never leave this module.

import { MAX_SOURCE_BYTES, MAX_SYMBOLS_PER_ANALYSIS } from "./limits";

export { MAX_SOURCE_BYTES, MAX_SYMBOLS_PER_ANALYSIS };
const PAGE_SIZE = 1000; // PostgREST returns at most 1000 rows per request

export type AnalysisMetrics = {
  filesTotal: number;
  filesAnalyzed: number;
  filesUnsupported: number;
  filesFailed: number;
  symbolsCount: number;
  relationshipsCount: number;
};

export type AnalysisOutcome =
  | { ok: true; metrics: AnalysisMetrics }
  // `recorded` is true when the analysis row now shows FAILED with this message.
  | { ok: false; error: string; recorded: boolean };

type ManifestFile = SourceFile;

async function loadManifest(snapshotId: string): Promise<ManifestFile[]> {
  const supabase = await createClient();
  const files: ManifestFile[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await supabase
      .from("repository_files")
      .select("id, path, language, size_bytes, content_hash")
      .eq("snapshot_id", snapshotId)
      .order("path")
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`Could not read the snapshot manifest: ${error.message}`);
    for (const row of data) {
      files.push({ id: row.id, path: row.path, language: row.language, sizeBytes: row.size_bytes, contentHash: row.content_hash });
    }
    if (data.length < PAGE_SIZE) return files;
  }
}

async function markFailed(analysisId: string, message: string): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fail_structure_analysis", {
    p_analysis_id: analysisId,
    p_error_message: message.slice(0, 2000),
  });
  return !error && data.length === 1;
}

export async function runStructureAnalysis(
  analysisId: string,
  provider: SourceProvider = getSourceProvider(),
): Promise<AnalysisOutcome> {
  await requireUser();
  if (!idSchema.safeParse(analysisId).success) return { ok: false, error: "Invalid analysis.", recorded: false };

  const supabase = await createClient();
  const { data: analysis, error: readError } = await supabase
    .from("repository_structure_analyses")
    .select("id, snapshot_id, status")
    .eq("id", analysisId)
    .maybeSingle();
  if (readError) return { ok: false, error: "Could not load the analysis.", recorded: false };
  if (!analysis) return { ok: false, error: "You do not have permission to do that.", recorded: false };
  if (analysis.status !== "PENDING") {
    return { ok: false, error: `The analysis is ${analysis.status}, not PENDING.`, recorded: false };
  }

  // No source retrieval configured: fail up front with a clear, retryable message (PENDING -> FAILED).
  if (!provider.available) {
    const recorded = await markFailed(analysisId, UNAVAILABLE_SOURCE_MESSAGE);
    return { ok: false, error: UNAVAILABLE_SOURCE_MESSAGE, recorded };
  }

  // Nothing can be signed without the server-only key: refuse before touching the analysis.
  const key = getStructurePersistKey();
  if (key === null) return { ok: false, error: KEY_MISSING_MESSAGE, recorded: false };

  // PENDING -> PROCESSING inside the database (row-locked, so two runs cannot both start). It re-checks that the
  // caller is OWNER/ADMIN and issues the random token that binds the signed persistence to this run.
  const { data: begun, error: startError } = await supabase.rpc("begin_structure_analysis", { p_analysis_id: analysisId });
  if (startError || !begun[0]) {
    return {
      ok: false,
      error: startError?.code === "55000" ? "The analysis is no longer PENDING." : "You do not have permission to do that.",
      recorded: false,
    };
  }
  const runToken = begun[0].run_token;

  try {
    const files = await loadManifest(analysis.snapshot_id);
    let analyzed = 0;
    let unsupported = 0;
    let failed = 0;
    const symbols: PersistedSymbol[] = [];
    const relationships: PersistedRelationship[] = [];

    for (const file of files) {
      const adapter = getParserAdapter(file.language);
      if (!adapter) {
        unsupported++; // language without a structural parser (or unknown): never an error, never fake symbols
        continue;
      }
      if (file.sizeBytes > MAX_SOURCE_BYTES) {
        failed++;
        continue;
      }

      const content = await provider.getContent(file);
      // The provider may only supply the exact bytes recorded for this snapshot.
      if (content === null || Buffer.byteLength(content, "utf8") !== file.sizeBytes || sha256Hex(content) !== file.contentHash) {
        failed++;
        continue;
      }

      let result;
      try {
        result = await adapter.parse({ path: file.path, source: content });
      } catch {
        failed++;
        continue;
      }
      if (!result.ok) {
        failed++; // malformed source: skipped, no partial symbols from it
        continue;
      }

      analyzed++;
      const offset = symbols.length;
      if (offset + result.structure.symbols.length > MAX_SYMBOLS_PER_ANALYSIS) {
        throw new Error(`The snapshot has more than ${MAX_SYMBOLS_PER_ANALYSIS} symbols; analysis stopped.`);
      }
      for (const symbol of result.structure.symbols) {
        symbols.push(
          persistedSymbolSchema.parse({
            file_id: file.id,
            name: symbol.name,
            kind: symbol.kind,
            qualified_name: symbol.qualifiedName,
            signature: symbol.signature,
            start_line: symbol.range.startLine,
            start_column: symbol.range.startColumn,
            end_line: symbol.range.endLine,
            end_column: symbol.range.endColumn,
            visibility: symbol.visibility,
          }),
        );
      }
      for (const relationship of result.structure.relationships) {
        // Indexes are per file; shifting by the file's offset keeps every relationship inside its own file's symbols.
        relationships.push(
          persistedRelationshipSchema.parse({
            source_index: relationship.sourceIndex + offset,
            target_index: relationship.targetIndex + offset,
            relationship_type: relationship.type,
          }),
        );
      }
    }

    // Sign exactly what is about to be persisted. The database recomputes the canonical message from the payload it
    // receives and the key held in Vault, so any difference (payload, counts, analysis id, run token) is rejected.
    const signature = signStructure(key, {
      analysisId,
      runToken,
      filesTotal: files.length,
      filesAnalyzed: analyzed,
      filesUnsupported: unsupported,
      filesFailed: failed,
      symbols,
      relationships,
    });

    // One RPC = one transaction: verify token + signature, clear, insert symbols, insert relationships, record
    // metrics, mark COMPLETED, consume the token.
    const { data, error } = await supabase.rpc("persist_structure_analysis", {
      p_analysis_id: analysisId,
      p_run_token: runToken,
      p_symbols: symbols,
      p_relationships: relationships,
      p_files_total: files.length,
      p_files_analyzed: analyzed,
      p_files_unsupported: unsupported,
      p_files_failed: failed,
      p_signature: signature,
    });
    if (error) throw new Error(`Could not persist the structure: ${error.message}`);
    const persisted = data[0];
    if (!persisted || persisted.status !== "COMPLETED") throw new Error("The analysis did not complete.");

    return {
      ok: true,
      metrics: {
        filesTotal: files.length,
        filesAnalyzed: analyzed,
        filesUnsupported: unsupported,
        filesFailed: failed,
        symbolsCount: persisted.symbols_count,
        relationshipsCount: persisted.relationships_count,
      },
    };
  } catch (error) {
    // Persistence is atomic, so nothing partial exists. Leave a consistent FAILED analysis that can be retried.
    const message = error instanceof Error ? error.message : "Structure analysis failed.";
    const recorded = await markFailed(analysisId, message);
    return { ok: false, error: message, recorded };
  }
}
