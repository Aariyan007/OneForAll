// Relative imports (not "@/"): keeps this pure module runnable by the plain-Node tests.
import { sha256Hex } from "../repository-files/manifest";
import type { SourceFile, SourceProvider } from "../repository-structure/source";

// A SourceProvider bound to ONE snapshot's recorded manifest and the bytes of ONE validated upload, held in server
// memory for the duration of the request. It answers only for manifest rows it was built with (same id, path and
// hash) and only with bytes whose size and SHA-256 match that row; anything else gets null. The analyzer checks the
// returned content against the manifest again before parsing.
export function createArchiveSourceProvider(
  manifest: readonly SourceFile[],
  contents: ReadonlyMap<string, Uint8Array>,
): SourceProvider {
  const byId = new Map(manifest.map((file) => [file.id, file]));
  return {
    available: true,
    async getContent(file) {
      const recorded = byId.get(file.id);
      if (!recorded || recorded.path !== file.path || recorded.contentHash !== file.contentHash || recorded.sizeBytes !== file.sizeBytes) {
        return null;
      }
      const data = contents.get(recorded.path);
      if (!data || data.byteLength !== recorded.sizeBytes || sha256Hex(data) !== recorded.contentHash) return null;
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
    },
  };
}
