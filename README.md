# OneForAll

**Repository intelligence and engineering knowledge for software teams.**

OneForAll links an organization's departments, teams, projects, requirements and tasks to the exact repository commits
those teams ship. It ingests a repository snapshot, extracts its code structure (symbols and the relationships between
them) and shows it as an interactive graph, so every engineer works from the same source of truth.

Final-year project (CSD 415 Project Work), Department of Computer Science and Engineering, Muthoot Institute of Technology
and Science. Team 14: Sunu Aariyan, Jithin P R, Mathew Maijo Kavalam.

> Status: Project Phase I. The AI layer and defect-risk prediction are planned and not implemented yet. This phase uses no AI, embeddings or RAG.

## Architecture

![System architecture: implemented layers in solid green, planned layers dashed](presentation-assets/diagrams/system_architecture.png)

Solid boxes are implemented; dashed boxes are planned.

![Current implementation architecture](presentation-assets/diagrams/implementation_architecture.png)

## Features

| Area | What is implemented |
| --- | --- |
| Identity and access | Email and password sign-up and sign-in (Supabase Auth), session refresh, protected routes |
| Organization hierarchy | Organizations → departments → teams → projects, with OWNER / ADMIN / MEMBER roles |
| Planning | Requirements and tasks per project |
| Repository snapshots | Record a repository and a commit; ingest a ZIP upload or a GitHub archive at an exact commit |
| File manifests | Path, language, size and SHA-256 for every file, sealed with an HMAC signature that the database verifies |
| Credential safety | `.env` files, private keys and `.npmrc` inside an archive are excluded and counted, never stored |
| Structure analysis | Symbols and relationships extracted with tree-sitter for TypeScript, JavaScript, Python and Java |
| Repository graph | Overview, file view, search, focused view and expand, read through bounded `SECURITY INVOKER` functions |
| Integrations | GitHub (public, or private with a fine-grained token) and Jira Cloud (one-way issue sync). Tokens are encrypted with AES-256-GCM |

Authorization lives in the database: every table is protected by PostgreSQL Row Level Security, and the application
re-checks access but is never the only guard.

## Tech stack

| Layer | Tools |
| --- | --- |
| App | Next.js 16 (App Router), React 19, TypeScript |
| UI | Tailwind CSS 4, custom component and icon set |
| Validation | Zod |
| Database and auth | Supabase (PostgreSQL, Auth, Vault), Row Level Security |
| Code analysis | web-tree-sitter with TypeScript, JavaScript, Python and Java grammars |

## Project layout

```text
src/
  app/              Next.js routes: (auth) pages and the (app) organization → project tree
  components/       UI: shell, repository graph, snapshots, integrations, shared ui
  lib/              Supabase clients, repository-graph transforms, shared helpers
  server/           Server-only modules: auth, organizations, teams, projects, requirements, tasks,
                    repositories, snapshots, repository-sources, repository-structure (parsers), integrations
supabase/
  migrations/       16 SQL migrations (schema, RLS, signed manifests, graph read functions, integrations)
  tests/            13 SQL test suites for Row Level Security and manifest validation
docs/               Setup checklist, ingestion, repository graph, integrations, phase handover
```

## Getting started

Prerequisites: Node.js 20+, Docker Desktop (for local Supabase).

```bash
npm install
npm run db:start          # starts local Supabase and applies supabase/migrations
cp .env.example .env.local
npx supabase status       # copy the API URL and publishable key into .env.local
npm run dev               # http://localhost:3000
```

Then follow [docs/manual-setup-checklist.md](docs/manual-setup-checklist.md) to create `STRUCTURE_PERSIST_KEY` and store
the same value in Supabase Vault. Without it, snapshot ingestion and structure analysis are rejected.

If an existing route shows the not-found page in development, run `npm run dev:clean`.

### Environment variables

| Name | Secret | Required | Purpose |
| --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | no | yes | Supabase API URL (local: `http://127.0.0.1:54321`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | no | yes | Publishable (anon) key; data is protected by RLS |
| `NEXT_PUBLIC_SITE_URL` | no | yes | App origin for auth email links (local: `http://localhost:3000`) |
| `STRUCTURE_PERSIST_KEY` | **yes** | for ingestion | 32+ random characters; the same value is stored in Vault as `structure_persist_key` |
| `INTEGRATION_ENCRYPTION_KEY` | **yes** | for GitHub/Jira tokens | 32+ random characters; server only, not stored in Vault |

Generate a value:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Never commit `.env.local`. No Supabase service-role key is used.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` / `npm run dev:clean` | Start the dev server (`dev:clean` clears the Turbopack cache first) |
| `npm run build` / `npm start` | Production build and server |
| `npm run lint` / `npm run typecheck` | ESLint and TypeScript checks |
| `npm run db:start` / `db:stop` | Start or stop local Supabase |
| `npm run db:reset` | Drop and recreate the local database (destroys local data) |
| `npm run db:types` | Regenerate `src/types/database.ts` from the local schema |

## Documentation

- [Manual setup checklist](docs/manual-setup-checklist.md)
- [Repository ingestion](docs/repository-ingestion.md)
- [Repository graph](docs/repository-graph.md)
- [Integrations](docs/integrations.md)
- [Phase handover](docs/phase-handover.md)

## Roadmap

- Webhooks and scheduled re-ingestion
- GitLab, Bitbucket and GitHub Enterprise Server sources
- Shared engineering context linking requirements, tasks and code entities
- AI services over that context (Q&A, review, tests, docs)
- Software defect-risk prediction
