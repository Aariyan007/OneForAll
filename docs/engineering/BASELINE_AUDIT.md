# Baseline audit (2026-10-26)

State of the repository before the AI orchestrator work, taken on branch `feature/ai-orchestrator` at commit
`092b9f4` (main `cd30c46` + the invitation-email fix). Every "verified" below cites evidence that was run or observed;
anything not run is marked so.

## Technology stack (detected)
| Layer | What is in the repository |
| --- | --- |
| App | Next.js 16.2.9 (App Router, Turbopack), React 19.2.4, TypeScript 5 |
| UI | Tailwind CSS 4, own component and icon set (`src/components/ui`) |
| Validation | Zod 4 |
| Database and auth | Supabase local stack (Postgres 17, Auth, Vault) via Docker; `@supabase/ssr` |
| Code analysis | `web-tree-sitter` 0.27 with TypeScript, JavaScript, Python and Java grammars |
| Email | `nodemailer` over Gmail SMTP (added in `092b9f4`) |
| AI | **none**: no LLM SDK, prompt, embedding or agent code anywhere |
| Package manager | npm (`package-lock.json`), Node 22.9 |

## Size
- 199 non-test source files under `src/`; 31 pages and 7 route handlers under `src/app`.
- 23 SQL migrations in `supabase/migrations`, 19 SQL test suites in `supabase/tests`.
- 14 unit test files (`*.test.ts(x)`).

## Entry points and commands
| Purpose | Command |
| --- | --- |
| Start local database (applies migrations to a new DB) | `npm run db:start` |
| Dev server | `npm run dev` (`npm run dev:clean` clears a stale Turbopack cache) |
| Production build and server | `npm run build`, `npm start` |
| Unit tests | `npm test` (added in this phase; `tsx --test` over `src/**/*.test.ts(x)`) |
| SQL suites | `npm run test:sql` (added in this phase; schema-only isolated copy, see `scripts/test-sql.sh`) |
| Lint, types | `npm run lint`, `npm run typecheck` |

## Architecture (as found)
- **Request path:** browser → `src/proxy.ts` (session refresh, optimistic redirect) → Server Components and Server Actions
  in `src/server/**` or Route Handlers → `@supabase/ssr` client acting **as the signed-in user** → PostgREST/RPC →
  Postgres with Row Level Security. No service-role key is used anywhere.
- **Authorization:** in the database (RLS, SECURITY INVOKER read functions, SECURITY DEFINER write functions that re-check
  roles). The app re-checks (`getOrgAccess`, chain helpers `getProjectContext` → `getRepositoryContext` →
  `getGraphAccess`) and returns 404 for anything not permitted.
- **Repository intelligence:** ZIP upload or GitHub archive → in-memory archive → manifest (path, language, size,
  SHA-256), HMAC-signed and verified by the database → tree-sitter structure analysis → symbols and relationships,
  HMAC-signed. **Source code is not stored after the request** (`repository_files` is metadata only, and
  `getSourceProvider()` in `src/server/repository-structure/source.ts` is deliberately unavailable).
- **Relationships are file-local**: no cross-file resolution of calls or imports.
- **Background work:** none. No queue or scheduler; deadline notifications run on page load.

## Existing AI and orchestration paths
None. The README (`Status: Project Phase I`) and the Review 1 deck list the AI Orchestrator and AI services (Q&A,
review, tests, docs) and defect-risk prediction as planned.

## Baseline test results (executed 2026-10-26)
| Suite | Command | Result |
| --- | --- | --- |
| Unit | `npm test` | **175 / 175 passed**, 0 skipped |
| SQL (isolated copy) | `npm run test:sql` | **19 / 19 suites passed** |
| Lint | `npx eslint .` | clean (0 problems) |
| Types | `npm run typecheck` | clean |
| Build | `npm run build` | succeeds |
| HTTP / browser harnesses | not in the repository | **not re-run**; `docs/phase-handover.md` reports 177/177 HTTP and 32/32 headless-browser checks from 2026-10-17 |

Manually observed in this session: sign-up, sign-in, dashboard, invitation email delivered over Gmail and accepted
through the public tunnel (confirmed by the user).

## Known failures and risks
| # | Finding | Severity | Evidence |
| --- | --- | --- | --- |
| 1 | `next` 16.2.9 has critical advisories (RCE in image optimization and `next/og`, proxy bypass, Server Action DoS/SSRF); `postcss` and `sharp` (via next) high; `zod` < 4.6.6 high | **P0** | `npm audit --omit=dev` |
| 2 | No security headers (CSP, HSTS, frame, nosniff) | P1 | `next.config.ts` |
| 3 | No health endpoint, no structured logging or correlation ids | P2 | code search |
| 4 | Source code discarded after ingestion, so no feature can read code later | P1 for AI | migrations `20261014000001`, `20261016000001`; `source.ts` |
| 5 | Sidebar footer "Settings — SOON" is a dead control | P3 | `src/components/shell/sidebar.tsx` |
| 6 | "Engineering Intelligence" nav link targets `#intelligence`, which is absent when no repository is connected; hash links are never highlighted | P3 | `nav-model.ts`, project page |
| 7 | No `npm test` script, no CI | P2 | `package.json`, no `.github/` |
| 8 | Docs counts are stale (README says 13 SQL suites; there are 19) | P3 | README |

## Environment dependencies
- Docker Desktop (local Supabase). Required.
- `STRUCTURE_PERSIST_KEY` in `.env.local` and the same value in Vault (`structure_persist_key`). Set and verified.
- `INTEGRATION_ENCRYPTION_KEY`. Set.
- `SMTP_USER`, `SMTP_PASSWORD` (Gmail app password), `APP_URL`. Set; login verified without sending, delivery verified.
- `GEMINI_API_KEY`. **Not set yet** (needed from Phase 3).

## Security observations
- Strong points: RLS on every table; HMAC-signed manifests and analyses; credentials encrypted with AES-256-GCM and
  never readable by the database; SSRF guards for outbound provider calls; generic client errors (`rpcErrorMessage`).
- Gaps: finding 1 and 2 above; Supabase Auth email confirmation is off locally (`supabase/config.toml`), so an
  account's email is not proven, which is why invitations require the emailed token.

## Uncommitted changes at baseline
The invitation-email work was uncommitted on `main`; it is now commit `092b9f4` on `feature/ai-orchestrator`.

## Features that could not be verified
- Private GitHub import with a fine-grained token (needs a token).
- Jira Cloud connect and sync (needs a Jira site and token).
- The HTTP and browser harness results quoted in `docs/phase-handover.md` (scripts are not in the repository).
