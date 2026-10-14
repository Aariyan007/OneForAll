// Central limits for uploaded source archives: the single source of truth for every layer. Pure constants (no I/O,
// no secrets). Imported by the ZIP reader, the ingestion service, the upload form (via a server-rendered prop), the
// tests and next.config.ts. All sizes are BINARY units (1 MiB = 1,048,576 bytes) and are labelled as such in the UI.
//
// Layers, outermost first (a request must pass all of them):
//   1. Hosting / reverse proxy: NOT configured in this repository (no vercel.json, Dockerfile or proxy config).
//      Whatever runs in front of Next.js in production must accept at least `uploadRequestBodyBytes`; some platforms
//      cap function request bodies lower (for example 4.5 MB on Vercel Functions), in which case the effective
//      limit is that platform limit until the upload path changes. See docs/repository-ingestion.md.
//   2. Next.js proxy request-body buffer (`experimental.proxyClientMaxBodySize`): `proxyBodyBufferBytes`.
//   3. Upload Route Handler (…/snapshots/[snapshotId]/source): refuses a request whose Content-Length exceeds
//      `uploadRequestBodyBytes` before reading the body. Uploads do NOT go through Server Actions, so the Server
//      Action body limit stays at the Next.js default (1 MB) for every other action.
//   4. Upload size checked by the form (UX) and again by the server (authoritative): `maxUploadBytes`.
//   5. ZIP reader limits on entries, names, decompressed sizes and ratios (below).
// Invariant (checked by the unit tests): maxUploadBytes < uploadRequestBodyBytes < proxyBodyBufferBytes, so an
// allowed upload is never truncated or refused by an outer layer of this application.

const KiB = 1024;
const MiB = 1024 * KiB;

export const ARCHIVE_LIMITS = {
  // Bytes of the uploaded .zip file itself.
  maxUploadBytes: 8 * MiB,
  // Central-directory records (files + directories) the reader will look at.
  maxEntries: 10_000,
  // Files that can enter one manifest (matches MAX_FILES_PER_INGEST in repository-files/ingest.ts).
  maxFiles: 5_000,
  // A single file larger than this (uncompressed) is excluded from the manifest, counted and reported; it is never
  // decompressed, truncated or parsed.
  maxFileBytes: 2 * MiB,
  // Sum of all decompressed, accepted files.
  maxTotalBytes: 64 * MiB,
  // Raw entry-name length in bytes (the manifest itself allows 1024 characters).
  maxNameBytes: 1024,
  // Uncompressed / compressed size of one entry. Real source code compresses far below this; zip bombs do not.
  maxCompressionRatio: 200,
  // Wall-clock budget for reading the archive (checked between entries).
  maxReadMillis: 30_000,
} as const;

export type ArchiveLimits = { [K in keyof typeof ARCHIVE_LIMITS]: number };

// Request-body limits. The upload request limit leaves 1 MiB of headroom over the upload limit for the multipart
// encoding. The proxy buffer is wired into next.config.ts.
export const BODY_LIMITS = {
  uploadRequestBodyBytes: ARCHIVE_LIMITS.maxUploadBytes + 1 * MiB,
  proxyBodyBufferBytes: 10 * MiB, // the Next.js default, set explicitly so it cannot drift silently
} as const;

// A snapshot left PROCESSING longer than this can be marked FAILED by an OWNER/ADMIN (crash/disconnect recovery).
export const STALE_PROCESSING_MILLIS = 10 * 60 * 1000;
