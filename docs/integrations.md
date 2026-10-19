# Project integrations: GitHub import and Jira Cloud

**Project → Integrations** (`…/projects/<projectId>/integrations`) has two cards:

- **GitHub:** import the source of an exact commit into a repository snapshot. This replaces downloading and uploading a ZIP by hand.
- **Jira Cloud:** a one-way, read-only copy of one Jira project's issues.

Everyone who can see the project sees the page. Only organization **OWNER** and **ADMIN** members can connect, import, sync or
disconnect. Team members see the state read-only. Other tenants get the not-found page.

Setup steps and credentials: [manual-setup-checklist.md](manual-setup-checklist.md).

## How credentials are kept
The browser and the server reach Supabase as the same signed-in user, and there is no service role. A secret stored where the
database can return it to that user would therefore also be readable from the browser. So:

1. The server encrypts each provider token with **AES-256-GCM** (`src/server/integrations/crypto.ts`). The key is derived with
   HKDF-SHA256 from the server-only environment variable **`INTEGRATION_ENCRYPTION_KEY`**. The associated data
   `OFA-INTEGRATION-V1|<projectId>|<kind>` binds a ciphertext to its project and provider, so it cannot be moved to another one.
2. The database stores only the ciphertext, in `private.integration_credentials`. No client role has privileges on that schema.
   It is written and read only through SECURITY DEFINER functions that check OWNER/ADMIN of the project's organization.
3. Tokens are never sent to the browser, never logged, never put in URLs and never stored in plaintext columns. Token inputs are
   write-only: the page shows "Token saved", never the value.
4. Without `INTEGRATION_ENCRYPTION_KEY` (or with one shorter than 32 characters) the page says integrations are not configured and
   refuses to save a credential. Public GitHub imports still work, because they need no credential.
5. **Changing or losing the key** makes every stored credential unreadable. Each action then reports "The stored credential cannot
   be decrypted. Enter it again." Nothing else breaks, and no data is lost.

## GitHub import
### Where
**Project page → Repository card → Import from GitHub** (OWNER/ADMIN, `github.com` repositories only). The Repository Intelligence
empty state and header link to it (`#import-github`), and the same panel is on **Project → Integrations**. The panel opens in place and
calls GitHub only when opened, so viewing a project costs no GitHub requests.

### Flow
1. The project's repository must be a `github.com` repository (`https://github.com/<owner>/<name>`). If the project has none,
   an admin who saved a token can pick one from the repositories that token can read.
2. **Check and branch:** opening the panel reads the repository on GitHub and records the result on the repository:
   - readable: status **Connected** and GitHub's visibility (Public / Private / Internal);
   - not found or not allowed: status **Error**, with a hint to add a token.
   Status changes follow the existing repository lifecycle (Error goes back through Pending), using the caller's own client, so RLS
   and the status trigger apply. Rate limits and timeouts change nothing. The branch list comes from GitHub (at most 300 branches,
   flagged when truncated). The recorded default branch is preselected; if it does not exist on GitHub, GitHub's default branch is used.
3. **Resolve commit:** leave the SHA empty for the branch's latest commit, or enter a full 40-character SHA. The server resolves it on
   GitHub and checks that the commit is on the branch, using the compare API (`identical` or `behind`). The page shows the SHA,
   message, date and a link to the commit on GitHub.
4. **Import this commit:**
   1. The server checks the commit again.
   2. It reuses a PENDING or FAILED snapshot of that commit, or creates one with the existing `create_repository_snapshot` RPC.
   3. It downloads `GET https://api.github.com/repos/{owner}/{repo}/zipball/{sha}`, for the exact SHA, never the branch name.
   4. It ingests the archive through the same pipeline as an uploaded ZIP: validation, limits, exclusions, the signed manifest and
      the structure analysis.
   5. The source is recorded as `GITHUB_ARCHIVE` / `PROVIDER_FETCHED`. See [repository-ingestion.md](repository-ingestion.md).
5. If the commit already has a COMPLETED snapshot, nothing new is created and the panel shows "Already imported" with a link to that
   snapshot. A snapshot that is PROCESSING is refused.
6. **After a successful import** the browser loads `…/projects/<id>?imported=<snapshotId>#intelligence`. The project page confirms the
   import from the database (snapshot status, file count, analysis status, links to the snapshot and graph); an id that is not a
   snapshot of this repository is ignored. A full page load is used on purpose: on this Next.js version (16.2.9),
   `router.refresh()` was observed to apply only some of the time (the refreshed RSC response was cancelled mid-stream and the page
   kept the old server output), in headless and in regular Chromium, on pages unrelated to this feature too.
7. **Failures** stay in the panel with the reason and a **Retry import** button. A snapshot created for a failed download stays
   PENDING and is reused by the next attempt; an ingestion failure leaves it FAILED, as for uploads.

The request stays open until processing ends (Route Handler, `maxDuration` 120 s). There is no background job.

### Authentication
- **Public repositories:** no token needed. GitHub then allows **60 API requests per hour per server IP address**, shared by every
  user of that server. Loading the card, resolving and importing a commit together use fewer than 10 requests.
- **Private repositories, or more than 60 requests per hour:** save a **fine-grained personal access token** on the GitHub card. Give it
  access to the repository, with **Contents: Read-only** (Metadata: Read-only is added automatically). Saving checks the token with
  GitHub (`GET /user`, then the repository) before storing anything; a rejected token is not stored.
- A token belongs to the project, not to the user who saved it, and every admin of the project uses it. It can be replaced or
  removed at any time. Removing it does not touch snapshots.
- Private repositories are implemented the same way but **have not been tested against a real private repository**. Do that before relying on it.

### Network safety (SSRF)
All provider traffic goes through `providerRequest` in `src/server/integrations/provider-http.ts`:

- **https only;** the host must be on the call's allow-list. GitHub: `api.github.com`. Archive redirect: only `codeload.github.com`.
- **Redirects** are followed by hand, up to the limit, and only to allowed hosts. The `Authorization` header is dropped when the host changes, so the token never goes to codeload.
- **User-influenced hosts** (Jira sites) are resolved first and refused when any address is private, loopback, link-local,
  CGNAT, multicast or reserved, IPv4 or IPv6, including the `169.254.169.254` metadata address.
- **Every response** has a byte cap and a timeout. A body over the cap is aborted, not truncated.
  - GitHub API: 2 MiB / 15 s.
  - GitHub archive: the 8 MiB upload limit / 60 s.
  - Jira: 4 MiB / 20 s.
- **Owner, repository, branch, SHA and Jira project key** are validated with strict patterns before they go into a URL or JQL.

### Failures and what the user sees
| Case | Result |
| --- | --- |
| Token revoked or wrong | "GitHub rejected the token" (401). The token stays stored until replaced or removed. |
| No access to the repository | Not found or forbidden, without saying which. |
| Rate limit | "GitHub rate limit reached", with the retry time when GitHub sends one. |
| Archive over 8 MiB | "The repository archive is larger than the 8 MiB import limit." Use a smaller commit or the ZIP upload. |
| Timeout or network error | "did not respond in time" or "could not be reached". The snapshot is marked FAILED when ingestion had started; import again to retry. |
| Unsupported or invalid archive | The same validation errors as for uploads (for example ZIP64 or unsafe paths). |
| Server stops mid-import | The snapshot stays PROCESSING. After 10 minutes, **Mark as failed** on the snapshot page, then import again. |

### Not ingested
The rules are the same as for uploads. Not recorded:

- `.git/`
- dependency and build folders: `node_modules`, `dist`, `build`, `.next`, `coverage`
- `__MACOSX/`
- files over 2 MiB
- files whose names suggest credentials: `.env*` except the template names, private keys, `.npmrc`, `.netrc` and similar

The snapshot page shows each count.

## Jira Cloud (one-way import)
### Flow
1. **Connect:** enter the site (`your-company.atlassian.net`), the Atlassian account email and an **API token**.
   - The server first checks the site name: only `https://<name>.atlassian.net`; any other host, IP address or port is refused before any request.
   - It then calls `GET /rest/api/3/myself`. Nothing is stored unless that succeeds.
2. **Project:** pick one Jira project from the list (at most 200 projects). Connecting with a different site or account clears the
   selected project. Issues imported earlier from another site or project stay in the table, under their own issue keys. Removal
   marking applies only to the currently selected site and project.
3. **Sync now** copies the project's issues:
   - It calls `POST /rest/api/3/search/jql` with `project = "<KEY>" ORDER BY key ASC`, 100 per page, using `nextPageToken`.
   - Fields: key, summary, status and status category, type, priority, assignee display name, and updated time.
   - Each issue links to `https://<site>/browse/<KEY>`.

### Rules
- **One-way and read-only.** OneForAll never writes to Jira. The table is labelled as a Jira copy, separate from OneForAll's own requirements and tasks.
- **Idempotent.** Issues are upserted on `unique (project_id, jira_site, jira_issue_id)`, so re-running a sync never duplicates.
- **Removed issues** get the "no longer in Jira" badge, and only after a complete, successful sync. A partial sync marks nothing.
- **At most 5,000 issues per sync.** Beyond that, the sync stops with status PARTIAL.
- **Errors:** rate limits (with `Retry-After`), a revoked token and permission errors are reported, and the last sync status, time and message are stored.
- **Stale data:** a "stale (over 24 h)" badge appears when the last sync is older than 24 hours. There is no scheduled sync.
- **Disconnect** removes the stored token and sets the integration to DISCONNECTED. Imported issues stay as a read-only copy, and no other data is deleted.
  Reconnecting to the same site and project continues the same mirror.

### API token and permissions
Create the token at <https://id.atlassian.com/manage-profile/security/api-tokens>. It acts as that Atlassian account, so
OneForAll sees only the projects and issues that account can browse. Prefer a dedicated account with **Browse projects** on
the one project. Scoped tokens and OAuth 2.0 (3LO) are not supported in this phase.

## Database (migration `20261021000001_project_integrations.sql`)
| Object | Purpose | Client access |
| --- | --- | --- |
| `public.project_integrations` | one row per project and provider (`unique (project_id, kind)`): status, Jira site, account email and project, last check and sync result | SELECT when the project is visible; no writes |
| `private.integration_credentials` | ciphertext only (format checked, at most 8 KiB) | none |
| `public.jira_issues` | the one-way issue mirror | SELECT when the project is visible; no writes |
| `save_project_integration`, `get_integration_ciphertext`, `select_jira_project`, `record_integration_result`, `disconnect_project_integration`, `upsert_jira_issues`, `mark_missing_jira_issues` | the only write and credential paths: SECURITY DEFINER, `search_path = ''`, EXECUTE for `authenticated` only, OWNER/ADMIN check inside | EXECUTE (`authenticated`) |

The same migration adds the `GITHUB_ARCHIVE` source kind and the `PROVIDER_FETCHED` verification. It also adds a trigger that sets verification from the source kind, and manifest signature V2.
It is additive: no table, column or row is dropped.

## Code map
| File | Role |
| --- | --- |
| `src/server/integrations/provider-http.ts` | SSRF-safe HTTP, error codes |
| `src/server/integrations/github.ts`, `jira.ts` | provider clients (pure apart from injected HTTP) |
| `src/server/integrations/jira-sync.ts` | paging, limits and missing-marking rules |
| `src/server/integrations/crypto.ts`, `integration-key.ts` | credential encryption, server-only key |
| `src/server/integrations/service.ts` | server-only orchestration (calls the RPCs and the ingestion pipeline) |
| `src/server/integrations/actions.ts` | Server Actions (token, connect, select, disconnect) |
| `…/projects/[projectId]/integrations/page.tsx`, `github/route.ts`, `jira/route.ts` | page and Route Handlers (same-origin check, OWNER/ADMIN, 404 otherwise) |
| `src/components/integrations/integration-client.tsx` | client forms; never receives a secret |

## Tests
- **Unit (mocked fetch and DNS, not real provider tests):** `src/server/integrations/integrations.test.ts`. It covers encryption, the SSRF
  guards, redirects, byte caps, timeouts, GitHub and Jira parsing, rate limits and sync paging and limits.
- **Database:** `supabase/tests/project_integrations_rls.sql`.
- **Against the real public GitHub API (no token),** done during development:
  - branch listing, commit resolution and the import of a public repository's exact commit, end to end, to COMPLETED with `PROVIDER_FETCHED`;
  - duplicate refusal, and rejection of an invalid token by GitHub.
- **Against the real Atlassian host,** done during development: refusal of an unknown `*.atlassian.net` site. **Jira success paths (connect,
  project list, sync) have not been run against a real Jira site;** they need a test site and API token.
