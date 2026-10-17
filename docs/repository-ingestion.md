# Repository source ingestion

A snapshot starts as a record of a commit (`PENDING`, no files). Source then enters in one of two ways, and both
use the same validation, exclusion, signing and analysis pipeline:

- **Uploaded ZIP** (this page, below). An OWNER or ADMIN uploads a ZIP of the commit. The source is `UNVERIFIED`.
- **GitHub import** (Project → Integrations, see [integrations.md](integrations.md)). The server resolves a branch to
  an exact commit on GitHub, downloads that commit's archive and ingests it. The source is `PROVIDER_FETCHED`.

OneForAll validates the archive, records the file manifest, seals the snapshot (`COMPLETED`) and runs the existing
structure analysis. Repository Intelligence and the Repository Graph then show the result.

There is no GitLab or Bitbucket download, no OAuth app, no webhook, no queue and no worker. The ZIP upload stays
available as the fallback for every repository.

## Workflow
1. **Projects → Repository Intelligence → Create snapshot.** Enter the full commit SHA and the branch. You land on the new snapshot's page.
2. **Snapshot page → Source ingestion → Upload and process.** A pending snapshot explains that creating it did not fetch any code, and shows the upload form first.
   The form shows the chosen file's name and size against the limit. **Upload and process** stays disabled until the selection is valid: a `.zip`, not empty, and within the limit. The server repeats every check. The request stays open until processing finishes.
   The form posts to the snapshot's upload Route Handler, `POST …/snapshots/<snapshotId>/source`, with `fetch`. A rejected upload shows its reason in the form; any recorded outcome (success, or a failure after processing started) reloads the page. Without JavaScript the form posts to the same URL and is redirected back to the snapshot page.
3. The server runs these steps (`src/server/repository-sources/ingestion.ts`):
   1. **Validate first.** The entire archive is checked before anything is written. An invalid archive leaves the snapshot unchanged.
   2. **Check the commit claim.** If the archive states a commit (ZIP comment) that differs from the snapshot's commit, the upload is rejected.
   3. **`PENDING | FAILED → PROCESSING`** with `begin_snapshot_ingestion`. The database locks the snapshot row, so only one concurrent request wins; the others get "already being processed". It refuses a commit that already has a COMPLETED snapshot in this repository (the database allows only one) before writing anything, clears what an earlier attempt left behind, and returns a one-time **run token**.
   4. **Record and complete, atomically**, with `persist_snapshot_manifest`. The server signs the source record and the whole manifest with the server-only key (HMAC-SHA256, see Security). The database checks the run token, the signature and the ingestion invariants, then writes the source record, every manifest row and `COMPLETED` in one transaction, and consumes the token. The manifest is now sealed.
   5. **Analyse.** The structure analysis runs through the existing signed pipeline (`analyzeSnapshot` → `runStructureAnalysis`). Its source is a provider bound to this snapshot.
4. Any failure after step 3 gives `PROCESSING → FAILED` (`fail_snapshot_ingestion`, which needs that attempt's run token) with a safe message. Nothing partial is left: step 4 records all of it or none of it. Upload again to retry: `begin_snapshot_ingestion` moves the snapshot `FAILED → PENDING → PROCESSING` and issues a new token; the failed attempt's token can never be used again.

## Status meaning
| Record | Meaning |
| --- | --- |
| Snapshot `PENDING` | Commit recorded, no source yet |
| Snapshot `PROCESSING` | An upload request is working on it right now |
| Snapshot `COMPLETED` | The file manifest is recorded and sealed. This does **not** mean the analysis is done. |
| Snapshot `FAILED` | Ingestion failed (message shown). Upload again to retry. |
| Analysis status (separate) | `PENDING` / `PROCESSING` / `COMPLETED` / `FAILED`, as before. The graph needs `COMPLETED`. |

The snapshot page shows the snapshot and the analysis separately. A snapshot with zero recorded files is never completed: an
archive with no recordable files is rejected.

**Re-analysing a COMPLETED snapshot.** The archive is not kept, so the analysis is re-run by uploading an archive whose
files match the recorded manifest **exactly** (same paths, sizes and SHA-256). A completed analysis is immutable and
cannot be overwritten.

**Stuck processing.** If the server stops mid-request, the snapshot stays `PROCESSING`. After 10 minutes an OWNER or ADMIN can
use **Mark as failed** (`fail_stale_snapshot_ingestion`, which the database allows without the lost run token only after the same 10 minutes) and upload again.

## Supported archive and limits
Only ZIP is supported, for example a Git host's "Download ZIP", `git archive --format=zip <commit>`, PowerShell
`Compress-Archive` or most zip tools. All limits are in `src/server/repository-sources/limits.ts`:

All sizes are binary (1 MiB = 1,048,576 bytes). `next.config.ts` and the upload Route Handler read their body limits from the same module, so the layers cannot drift apart. A unit test also checks the ordering upload < upload request body < proxy buffer.

Uploads do **not** use a Server Action. File bytes never pass through the Server Action protocol, so the Server Action body limit stays at the Next.js default (1 MB) for every other action.

| Layer | Limit | Where it is enforced |
| --- | --- | --- |
| Hosting / reverse proxy | **Not configured in this repository** (no vercel.json, Dockerfile or proxy config). It must accept at least the upload request limit. | Deployment |
| Next.js proxy body buffer | 10 MiB (10,485,760 bytes) | `experimental.proxyClientMaxBodySize` |
| Upload request body | 9 MiB (9,437,184 bytes): the upload limit plus 1 MiB for the multipart encoding. Checked against `Content-Length` before the body is read. | Upload Route Handler (`…/snapshots/[snapshotId]/source/route.ts`) |
| Upload (.zip file) | 8 MiB (8,388,608 bytes) | Form (feedback), ingestion service and reader (authoritative) |
| Archive entries (files + folders) | 10,000 | ZIP reader |
| Recorded files | 5,000 | Archive reader (same as `MAX_FILES_PER_INGEST`) |
| One file, uncompressed | 2 MiB. Larger files are **not recorded**: counted, listed after the upload, never decompressed, truncated or parsed. | ZIP reader |
| All recorded files, uncompressed | 64 MiB, measured on the actual decompressed bytes | ZIP reader |
| Entry name | 1,024 bytes (the manifest allows 1,024 characters) | ZIP reader and manifest |
| Compression ratio per entry | 200 : 1 | ZIP reader |
| Read time | 30 s. The upload route allows 120 s (`maxDuration`) for the whole request. | ZIP reader and upload route |
| Parser, per file | 1,000,000 bytes. Recorded files above this are counted as "could not be analysed". | Structure analyzer (Phase 2H) |
| Symbols per analysis | 50,000 | Structure analyzer (Phase 2H) |

Declared sizes are never trusted on their own. A file is decompressed with an output cap equal to its declared size, and its actual length and CRC-32 must then match; the total limit is checked against those verified sizes. A file that declares more than the per-file limit is not decompressed at all.

**Before raising the upload limit**, raise the hosting and proxy body limits first; changing Next.js alone is not enough. Some platforms cap function request bodies below 8 MiB (Vercel Functions: 4.5 MB). On such a platform the effective limit is that cap until the upload path changes, for example to a direct upload to object storage.

### What is not recorded, and how it is counted
Every file in the archive is either recorded in the manifest or excluded in exactly one category, so recorded + excluded = files in the archive. The counts are stored on `repository_snapshot_sources` (migration `20261017000001`) and shown on the snapshot page:

| Category | Rule | Column |
| --- | --- | --- |
| Archive metadata | `__MACOSX/` | `files_skipped_metadata` |
| Generated folders | inside `node_modules`, `.git`, `dist`, `build`, `.next` or `coverage`; takes precedence over size | `files_skipped_generated` |
| May contain credentials | file name `.env` or `.env.*` (except `.env.example`, `.env.sample`, `.env.template`, `.env.dist`), `.npmrc`, `.pypirc`, `.netrc`, `.git-credentials`, `.htpasswd`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, or extension `.pem`, `.key`, `.p12`, `.pfx`, `.jks`, `.keystore` (case-insensitive) | `files_skipped_sensitive` (migration `20261021000001`) |
| Over the per-file limit | larger than 2 MiB | `files_skipped_oversized` |

- Each file gets exactly one category, in this order: metadata, generated folder, may contain credentials, over the limit.
- "May contain credentials" is a file-name safety net, **not secret scanning**. Such files are never recorded, hashed or parsed (a hash of a short secret could be guessed offline). A secret inside an ordinary source file is still recorded as that file's hash and parsed for symbols; the graph shows symbol names and file paths, never file contents.
- Rows written before migration `20261017000001` have no breakdown; the page shows "Not recorded", never zero. Rows written before `20261021000001` have no credentials count (`NULL`, shown as "Not recorded").
- Unsupported languages are not excluded: those files are recorded, and the analysis counts them as unsupported. Likewise, files the analysis could not parse are counted by the analysis, not the upload.
- Those analysis counts exist only once the analysis has completed; until then the page says they are unavailable.
- The Repository Graph covers only recorded files that were analysed.

The reader is `src/server/repository-sources/zip.ts`, built on Node's `zlib` with no new dependency. It rejects:
- ZIP64, multi-part and encrypted archives, and compression other than STORE or DEFLATE;
- data before, between or after the entries;
- overlapping entries;
- symbolic links and special files;
- non-UTF-8 names;
- CRC or size mismatches, and compression bombs. Decompression is bounded by the declared size.

`src/server/repository-sources/archive.ts` then applies the path rules:
- **Unsafe paths reject the archive:** every path goes through the manifest's `normalizeRepositoryPath`, so absolute, drive-letter, `..`, backslash traversal, control characters and null bytes are all rejected. C1 control characters (U+0080–U+009F) are rejected as well: the normalizer allows them but the database path `CHECK` does not.
- **Collisions reject the archive:** duplicate, Unicode-normalization (NFC) and case-insensitive collisions, and a path that is both a file and a folder.
- **One top-level folder is stripped:** a single shared top-level folder (for example `repo-<sha>/`) is treated as the repository root, unless it is an ignored folder. This is a heuristic. A repository whose only top-level entry really is one folder (say, just `src/`) is recorded without that folder in its paths.
- **Skipped, not recorded:** `__MACOSX/` metadata, the manifest's ignored folders (`node_modules`, `.git`, `dist`, `build`, `.next`, `coverage`) and files that may contain credentials (table above).

## Hashes and source verification
- **Manifest:** each recorded file stores its normalized path, its language (from the extension), its byte size and the SHA-256 of its exact bytes. This uses the existing `prepareManifest`; the content itself is never stored.
- **Before parsing:** the source provider (`src/server/repository-sources/provider.ts`) returns only manifest rows of this snapshot, and only bytes whose size and SHA-256 match. The analyzer then checks the content against the manifest again.
- **Verification:** the database sets `repository_snapshot_sources.verification` from `source_kind` with a trigger (migration `20261021000001`); no caller chooses it.

  | `source_kind` | `verification` | Meaning |
  | --- | --- | --- |
  | `UPLOADED_ARCHIVE` | `UNVERIFIED` | An uploaded archive is not proof of what the commit contains. `archive_commit` is the commit the archive **claims** (its ZIP comment) and is shown as "self-reported". |
  | `GITHUB_ARCHIVE` | `PROVIDER_FETCHED` | The server resolved the commit on GitHub, checked it is on the chosen branch, and downloaded `GET /repos/{owner}/{repo}/zipball/{sha}` for that exact SHA. An archive comment that states a different commit is rejected, as for uploads (GitHub writes the commit SHA there). github.com is the authority; OneForAll does not re-hash the Git tree. |

  `source_kind` is part of the signed manifest, so a caller cannot relabel an upload as provider-fetched without the server key.

## Storage, retention and cleanup
- The archive and the accepted files exist **only in the memory of the upload request**. Nothing is written to disk, so there is no extraction directory and no path can escape one.
- Nothing is left behind after a success, a failure, an abandoned upload or a server restart.
- The database keeps only:
  - **The manifest:** path, language, size and hash, in `repository_files`.
  - **The source record:** kind, verification, archive SHA-256 and size, the commit claim, counts and the uploader, in `repository_snapshot_sources`.
- **Retries:** anything a previous attempt left behind is deleted by `begin_snapshot_ingestion`, after the new attempt has won the row lock. (Since migration `20261018000001` a failed attempt leaves nothing behind; the cleanup also covers rows written by the earlier, non-atomic flow.)

## Security
- The upload route checks, in order:
  1. **Same origin:** the `Origin` host must equal the request host (CSRF protection; Server Actions get this from Next.js, a Route Handler must do it itself). Otherwise 403.
  2. **Declared size:** `Content-Length` is required and must be within the upload request limit, before the body is read. Otherwise 411 or 413.
  3. **Session:** the Supabase session is verified. Otherwise 401 (the proxy already redirects signed-out requests to `/login`).
  4. **Chain:** the whole organization → department → team → project → repository → snapshot chain is re-verified from the database. Ids in the URL are only targets, so tampered ids reach nothing (403).
- The **Mark as failed** Server Action re-verifies the same chain.
- **No direct client writes** (migration `20261018000001`, additive). Through the Data API, clients can read snapshots, manifests and source records (unchanged visibility), create a PENDING snapshot and delete a whole snapshot (OWNER/ADMIN; its manifest and source record cascade). They have **no** INSERT/DELETE on `repository_files` or `repository_snapshot_sources` and **no** UPDATE of any column of `repository_snapshots`.
- **Lifecycle functions** (SECURITY DEFINER, `search_path = ''`, EXECUTE for `authenticated` only, revoked from `PUBLIC` and `anon`). Each checks inside the database that the caller is signed in and OWNER/ADMIN of the organization derived from the snapshot; an unknown snapshot and a forbidden one both give `42501`:

  | Function | Transition | Requires |
  | --- | --- | --- |
  | `begin_snapshot_ingestion(id)` | `PENDING`/`FAILED` → `PROCESSING` | no COMPLETED snapshot of the same commit; returns a new run token |
  | `persist_snapshot_manifest(id, token, source, files, signature)` | `PROCESSING` → `COMPLETED` | the current run token, a valid HMAC signature, 1–5,000 files, `files_accepted` = number of files, a complete exclusion breakdown, no conflicting commit claim; every table CHECK |
  | `fail_snapshot_ingestion(id, token, message)` | `PROCESSING` → `FAILED` | the current run token |
  | `fail_stale_snapshot_ingestion(id)` | `PROCESSING` → `FAILED` | processing started at least 10 minutes ago |

- **Signed manifests.** The signature is HMAC-SHA256 over a canonical message (`OFA-MANIFEST-V2` since migration `20261021000001`, which added the GitHub source kind and the credentials count to the source line; defined in `src/server/repository-files/signing.ts` and `private.manifest_canonical()`; a fixed test vector keeps them identical). It uses the existing server-only key of Phase 2H structure persistence (`STRUCTURE_PERSIST_KEY`, Vault secret `structure_persist_key`); the version line keeps manifest and structure signatures apart. An OWNER/ADMIN can call the functions directly but cannot produce a signature the database accepts, so cannot forge, alter, re-target or replay a manifest, or complete a snapshot without one. Run tokens live in `private.snapshot_ingestion_runs` (not exposed to any client) and exist only while a snapshot is `PROCESSING`.
- **Payload validation** (migration `20261019000001`, `private.manifest_payload_check`). Even a correctly signed payload must have exactly the expected keys and JSON types, plain integers within range, a language name (letters, digits, `+`, `#`) or null, no NFC-equivalent or case-insensitive duplicate paths, no path inside an excluded folder or `__MACOSX/`, and no file name from the "may contain credentials" list (mirrors `IGNORED_DIRECTORIES`, `isSensitivePath` and the archive reader: change both together). A signature that is not 64 lowercase hex characters is rejected up front (`22023`). The HMAC is compared on raw bytes as a double HMAC, because pgcrypto has no constant-time comparison.
- **Sealed manifests.** A trigger refuses every UPDATE of a manifest row, and every INSERT into or DELETE from the manifest of a COMPLETED snapshot, whoever the writer is. Deleting the snapshot (or anything above it) still cascades.
- `repository_snapshot_sources` (migration `20261016000001`): visible exactly when its snapshot is visible; written only by `persist_snapshot_manifest` (uploader = the caller, verification set by the trigger from `source_kind`); never updatable.
- No service role is used.
- Structure is still written only through the signed (HMAC-SHA256) persistence and run token of Phase 2H.
- Errors shown to users are generic, with no internal paths or database messages. Source code, run tokens and keys are never sent to the browser or logged.

**Resolved (Phase 2G gap).** Before migration `20261018000001`, OWNER/ADMIN users could insert or delete `repository_files`
rows and move a snapshot through its lifecycle (even to `COMPLETED` with no files) directly through PostgREST. Those direct
writes are now denied; see `supabase/tests/repository_manifest_lifecycle_rls.sql`.

## Runtime limitations
- Processing is synchronous inside one request. There is no background job. Keep the page open until it finishes.
- A request whose declared body is over 9 MiB is refused by the upload route with HTTP 413 and a readable message before the body is read; nothing changes. The form already disables uploads of files over 8 MiB.
- Because the archive is not stored, re-running a FAILED analysis needs the same archive uploaded again.

## Not supported yet
- GitLab, Bitbucket and GitHub Enterprise Server ingestion; GitHub App or OAuth sign-in (GitHub uses an optional fine-grained token, see [integrations.md](integrations.md))
- Private GitHub repositories are implemented but **not yet tested against a real private repository**
- Webhooks and scheduled re-ingestion
- Formats other than ZIP (tar, tar.gz, 7z, rar)
- Verifying an uploaded archive against a Git host

## Tests
- **Unit tests:**
  - `src/server/repository-sources/sources.test.ts`: archives built in memory, covering boundaries, adversarial input and exclusion accounting.
  - `src/lib/repository-sources/upload.test.ts`: form and server selection rules, and limit consistency.
  - `src/server/integrations/integrations.test.ts`: GitHub and Jira clients, SSRF guards and credential encryption, with mocked `fetch` and DNS (not real provider tests).
  All use `node:test`. Run either file:
  ```bash
  npx tsc src/server/repository-sources/sources.test.ts --outDir <tmp-dir> --module commonjs --target es2022 --moduleResolution node --skipLibCheck --strict --esModuleInterop --types node
  ```
  ```bash
  node --test <tmp-dir>
  ```
- **Database:** one transaction each, rolled back.
  - `supabase/tests/repository_manifest_lifecycle_rls.sql`: grants and functions, the Node/database signature vector, OWNER/ADMIN ingestion, MEMBER and cross-tenant denial, denial of direct Data API writes, empty or incomplete manifests, forged/tampered/re-targeted/replayed manifests and run tokens, sealed COMPLETED manifests, failure and retry, stale recovery, the one-COMPLETED-per-commit race, and structure analysis and reads afterwards. It signs with the key already in Vault (read only inside the database, never changed) and adds a test key, inside the transaction, only when Vault has none.
  - `supabase/tests/repository_manifest_validation_rls.sql`: signed but malformed payloads, signature format, helper privileges, TRUNCATE, and the seal under ordinary deletes and cascades.
  - `supabase/tests/repository_snapshot_sources_rls.sql`: source-record visibility, denial of every direct write, and the table rules (including the verification trigger).
  - `supabase/tests/project_integrations_rls.sql`: integration settings, stored ciphertext and the Jira issue mirror.
  Run either:
  ```bash
  docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_snapshot_sources_rls.sql
  ```
- **Manually:**
  1. Create a snapshot whose commit SHA is the one you will archive.
  2. Make the archive:
     ```bash
     git archive --format=zip -o source.zip <commit>
     ```
  3. Upload `source.zip` on the snapshot page.
  4. Open the Repository Graph from the analysis card.

### Running the SQL suites in an isolated database
- **Why:** `repositories_rls.sql` and `repository_snapshots_rls.sql` assert global row counts (`count(*) = 0` after their own cascading deletes). They therefore fail in a database that also holds real data. They pass on an empty schema.
- **What this does:** runs them against a schema-only copy in the same local Postgres container. It never touches the `postgres` database or its data. Run in order:
  1. Dump the schema only:
     ```bash
     docker exec supabase_db_OneForAll pg_dump -U postgres -s -d postgres -f /tmp/ofa_schema.sql
     ```
  2. Create the empty copy:
     ```bash
     docker exec supabase_db_OneForAll createdb -U supabase_admin ofa_rls_iso
     ```
  3. Restore the schema into it:
     ```bash
     docker exec supabase_db_OneForAll psql -U supabase_admin -d ofa_rls_iso -q -f /tmp/ofa_schema.sql
     ```
  4. Give it the same owner as the main database:
     ```bash
     docker exec supabase_db_OneForAll psql -U supabase_admin -d postgres -c "alter database ofa_rls_iso owner to postgres"
     ```
  5. Run a suite against the copy (repeat for each file):
     ```bash
     docker exec -i supabase_db_OneForAll psql -U postgres -d ofa_rls_iso -v ON_ERROR_STOP=1 < supabase/tests/repositories_rls.sql
     ```
  6. Remove the copy when done:
     ```bash
     docker exec supabase_db_OneForAll dropdb -U postgres ofa_rls_iso
     ```
- The ownership step matters: `pg_database_owner`, which holds `CREATE` on `public`, must be `postgres`, as in the main database.
