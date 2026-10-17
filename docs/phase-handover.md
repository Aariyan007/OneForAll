# Phase handover (2026-10-17)

State at handover: the work below is **uncommitted** on `main`. Nothing was pushed, deployed or applied to a hosted database.
Setup steps: [manual-setup-checklist.md](manual-setup-checklist.md). Details: [repository-ingestion.md](repository-ingestion.md),
[repository-graph.md](repository-graph.md), [integrations.md](integrations.md).

## Feature matrix
| Feature | State | Evidence |
| --- | --- | --- |
| Sign up, sign in, session, route guard | Implemented and verified | every HTTP and browser harness signs in through Supabase Auth; signed-out requests are redirected to `/login` |
| Organizations, departments, teams, projects, roles | Implemented and verified | SQL suites (`organizations`, `departments`, `teams`, `projects`) |
| Requirements and tasks | Implemented and verified at database level | `requirements_tasks_rls.sql`; UI not re-tested in this phase |
| Repository connection (manual URL) | Implemented and verified | `repositories_rls.sql`, ingestion harness |
| Snapshots and ZIP upload ingestion | Implemented and verified | ingestion HTTP harness (70 checks), failure harness (18), upload form in headless Chrome (11) |
| Signed manifest (V2), validation, seal | Implemented and verified | manifest lifecycle and validation SQL suites (Node/DB test vector) |
| Excluding files that may contain credentials | Implemented and verified | unit test, SQL validation cases, snapshot page |
| Structure analysis | Implemented and verified | runs after every ingestion; `repository_structure_rls.sql` (isolated database) |
| Repository graph: overview, file view, search, focused view, expand | Implemented and verified | graph HTTP (23), explore HTTP on the 13,506-symbol analysis (30), headless Chrome (11), unit tests |
| Unauthorized access rejected (members, other teams, other tenants, tampered ids) | Implemented and verified | all harnesses and SQL suites |
| GitHub import, public repository, exact commit | Implemented and verified **against real GitHub** (no token) | integrations HTTP harness (36), headless Chrome import (10) |
| GitHub import, private repository with a fine-grained token | Implemented, **not verified** (blocked by credentials) | mocked unit tests only; an invalid token was rejected by real GitHub |
| Jira Cloud connect, project select, sync, issue list, disconnect | Implemented; success paths **not verified** (blocked by credentials) | mocked unit tests and SQL suite; refusal of invalid and unknown sites was checked against the real host |
| Stale Turbopack dev routes | Mitigated (`npm run dev:clean`) | reproduced and cleared on 2026-10-17 |
| Server-rendering stack overflow on deep routes (dev) | Fixed (`RenderTaskBoundary`) | 0 `RangeError` across 4 fresh dev-server starts |
| Webhooks, scheduled re-ingestion and sync | Missing | out of scope |
| GitLab, Bitbucket, GitHub Enterprise Server, Jira Data Center | Missing | out of scope |
| Writing back to Jira; mapping Jira issues to requirements | Missing (deliberately one-way) | — |
| Deployment configuration (hosting, body limits, env) | Missing | see checklist section 7 |

## Changes in this phase
- **Migration `20261021000001_project_integrations.sql`** (new, additive; applied to the **local** database only):
  - tables `project_integrations`, `private.integration_credentials` and `jira_issues`, plus the definer functions;
  - the `GITHUB_ARCHIVE` / `PROVIDER_FETCHED` source kind and verification, set by a trigger;
  - manifest signature V2 and the credentials count.
- **Migration `20261020000001_repository_graph_read_functions.sql`** (from the graph work, also uncommitted; applied locally).
- **Server, new:** `src/server/integrations/*`, `src/server/http/request-guards.ts`.
- **Server, changed:** `src/server/repository-sources/archive.ts` (credentials exclusion), `ingestion.ts` (provider archives) and `src/server/repository-files/signing.ts` (V2).
- **UI:**
  - new Integrations page and the client components in `src/components/integrations/`;
  - project page: an Integrations button;
  - snapshot page: a "Fetched from GitHub" badge and a credentials row;
  - new-snapshot page: a link to the GitHub import.
- `package.json`: the `dev:clean` script. `.env.example`: server-only variable names with empty values.

## Bugs and gaps fixed
1. **Credential files could be ingested.** Before this phase, `.env`, private keys and `.npmrc` inside an archive were recorded, hashed and parsed.
   They are now excluded and counted. The database rejects them in signed payloads too.
2. **No way to tell a provider-fetched source from an upload.** `verification` could only be `UNVERIFIED`. It is now derived from the signed source kind by a trigger.
3. **Stale dev routes** came back after new route files were added: the dev server showed the not-found page for the existing graph route.
   Clearing `.next/dev/cache/turbopack` fixes it, and `npm run dev:clean` does that.
4. Test harness fixes only (no product change): boolean text comparison, outdated fixture pointers, fixture order.

## Test results (2026-10-17, all executed and observed)
| Group | Suite | Result |
| --- | --- | --- |
| Unit (`node:test`) | upload 8, sources 28, graph 20, explore 16, render-task-boundary 3, integrations 28 | **103 / 103 passed** |
| SQL, isolated schema-only copy | all 13 suites | **13 / 13 passed** |
| SQL, main local database | 10 of 12 run passed | `repositories_rls.sql` and `repository_snapshots_rls.sql` **failed**: they assert global row counts and the main database holds real data (both pass on the isolated copy). `repository_structure_rls.sql` **not run** there because it rewrites the Vault key. |
| HTTP, production build | integrations 36, ingestion 70, ingestion failures 18, graph 23, explore 30 | **177 / 177 passed** |
| Browser (headless Chrome) | upload form 11, graph explore 11, GitHub import 10 | **32 / 32 passed** |
| Dev server | new routes, graph routes, stack overflow | all routes 200 after `dev:clean`; 0 `RangeError` |
| Gates | `tsc --noEmit`, `eslint`, `next build`, `git diff --check`, client-bundle secret scan | all clean |

The integration unit tests use mocked HTTP and DNS. They are **not** provider integration tests. The only real-provider checks are
the GitHub public-repository flow and the refusal of unknown Atlassian sites.

## Handover tasks
1. **Review, then commit** the uncommitted work. Do not stage `.history/`.
2. **Private GitHub repository:** create a fine-grained token (checklist section 5) and import a private repository.
   Check the snapshot shows `PROVIDER_FETCHED`, and that removing the token stops access.
3. **Jira:** using a Jira Cloud test site and API token (checklist section 6), check:
   - connect;
   - the project list;
   - a sync of more than 100 issues (paging);
   - a re-sync (no duplicates);
   - deleting an issue in Jira, then re-syncing ("no longer in Jira");
   - disconnecting (issues kept).
4. **Hosted database:** review both new migrations, back up, then `npx supabase db push`. Create the Vault secret and set both server keys on the host.
5. **Consider later:**
   - a background job for imports over 2 minutes or 8 MiB;
   - webhooks or scheduled sync;
   - a GitHub App instead of personal tokens;
   - making the two global-count SQL suites independent of existing data.
