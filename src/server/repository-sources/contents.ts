// Which archive files get their text stored (migration 20261028000002), and how they are batched for
// store_snapshot_contents. Pure (no I/O) so it runs in the plain-Node tests; the database re-checks every limit and
// the SHA-256 of each file against the sealed manifest.

export const CONTENT_LIMITS = {
  maxFileBytes: 1_000_000, // same bound as the structure analyzer's MAX_SOURCE_BYTES and the database CHECK
  maxBatchBytes: 1_500_000, // keeps each RPC request small
  maxBatchFiles: 500, // the database accepts at most 1000 per call
} as const;

export type ContentFile = { path: string; content: string };

const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// The exact text of a file when it is storable: valid UTF-8 (so re-encoding gives the same bytes and the same hash),
// no NUL bytes (binary, and Postgres text cannot hold them), and within the size limit. Otherwise null.
export function decodeStorableText(bytes: Uint8Array): string | null {
  if (bytes.byteLength > CONTENT_LIMITS.maxFileBytes || bytes.includes(0)) return null;
  try {
    return strictUtf8.decode(bytes);
  } catch {
    return null;
  }
}

export function contentBatches(
  paths: readonly string[],
  contents: ReadonlyMap<string, Uint8Array>,
): { batches: ContentFile[][]; skipped: number } {
  const batches: ContentFile[][] = [];
  let current: ContentFile[] = [];
  let currentBytes = 0;
  let skipped = 0;
  for (const path of paths) {
    const bytes = contents.get(path);
    const text = bytes ? decodeStorableText(bytes) : null;
    if (!bytes || text === null) {
      skipped++;
      continue;
    }
    if (current.length > 0 && (currentBytes + bytes.byteLength > CONTENT_LIMITS.maxBatchBytes || current.length >= CONTENT_LIMITS.maxBatchFiles)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push({ path, content: text });
    currentBytes += bytes.byteLength;
  }
  if (current.length > 0) batches.push(current);
  return { batches, skipped };
}
