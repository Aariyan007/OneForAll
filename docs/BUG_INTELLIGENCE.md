# Bug intelligence: project graph, AI bug scan, assignment and approved fixes

This document describes what was added on branch `feature/bug-intelligence`, how each part works, who may do what, the
limits that are real today, and a step-by-step demo. Everything below was run against the local stack and the real Gemini
API; the numbers quoted come from those runs, not from estimates.

## 1. What a person can do now

| Step | Who | Where |
| --- | --- | --- |
| Connect a repository by URL **without** a branch or commit SHA | owner / admin | Project → Repository |
| Import the latest commit of the default branch (the server resolves branch and commit) | owner / admin | Project → Integrations → "Import latest from this branch" |
| See the **whole-project graph**: directories, files, imports between files, symbols, real counts | owner, admin, employee (RLS) | Snapshot → "View Project Graph", or Organization → "Repos & bugs" |
| Scan the whole project with AI and get evidence-backed bugs | owner / admin | Project → Bugs → "Scan this repository" |
| Assign a bug manually (ranked people with reasons) or automatically | owner / admin | Bug page, or Bugs list → "Auto-assign" |
| Work a bug in a 3-pane workspace: details, highlighted code, task graph, AI fix plan | assignee / admin | Project → Bugs → a bug |
| Approve, reject or request changes on an AI fix; approval applies it to the stored working copy and validates it | assignee / admin | Bug page → Fix workflow |
| Hand the fix on: testing → code review → QA → resolved (each with written evidence) | assignee, then someone else | Bug page |
| See your queue / the organization's queue, workload and AI cost | each person / admin | "My bugs", Organization → "Repos & bugs" |
| Switch light / dark mode | everyone | sun/moon button in the top bar |

## 2. Import without a SHA, and the project graph

* `connectFields.defaultBranch` is optional. When empty, `createRepository` asks GitHub for the repository's default branch
  and visibility (`detectGitHubDefaultBranch`), and stores them.
* The import button posts `{ op: "import", branch }`. The server resolves the branch tip to an exact commit, downloads
  that commit, validates and ingests it, and records the commit on the snapshot. Importing the same commit again says
  "Already up to date".
* Ingestion stores the file list, the file **text** (hash-verified), the tree-sitter symbols, and now the
  **file-to-file import edges** (`repository_file_edges`, written by `store_file_edges`, resolved by
  `src/lib/project-graph/imports.ts` for TypeScript/JavaScript, Python and Java). An import is an edge only when it
  resolves to a file of the same snapshot; package imports are not edges.
* The Project graph page (`…/snapshots/{id}/project-graph`) shows files, directories, parsed vs unparsed files, symbols,
  import links, node and edge totals. Counts come from stored rows, never estimates. The viewer supports pan, zoom,
  folder expand/collapse (imports between hidden files roll up to the folder), search (files and symbols), a language
  filter, "files with imports", a details panel (imports / imported by / symbols with line links), "Show
  neighbourhood", "Open file" and reset. Owners and admins can "Rebuild import links" for snapshots imported earlier.
* Graph vocabulary: `CONTAINS` (tree), `IMPORTS` (file→file), symbols from the structure analysis; bug nodes add
  `ASSOCIATED_WITH` and `FIXED_BY`. Edges not reliably known (cross-file `CALLS`, `DEPENDS_ON` from package manifests)
  are **not** drawn.

Measured: `sindresorhus/slash` imported with no SHA: branch `main` detected, 13 files, 2 import links, 9 symbols.

## 3. AI bug scan

* Planning (`src/lib/bugs/scan.ts`, pure and tested): skips non-source, generated, lock, minified and binary files;
  puts the most depended-on files first and tests last; splits large files into line-range parts (instead of skipping
  them); packs files into batches of at most 4 units / ~40 KB; caps a scan at 40 files / 60 units.
* Each batch is one `bug_scan` AI run through the existing orchestrator (state machine, retries, tier fallback, secret
  redaction, token budget, `ai_runs` accounting). The server drives batches in bounded requests (`POST …/bugs/scan`
  `op: "step"`, up to ~4.5 minutes each); the browser asks for the next step until the scan is over.
* **Evidence rule**: a finding is stored only when its quoted code is found at (or within 3 lines of) the cited lines
  (`verifyEvidence`). Findings pointing outside the batch, at impossible lines, or quoting invented code are dropped and
  counted. Findings are de-duplicated per project by `sha256(path + normalised evidence)`.
* Fields stored per bug: title, description, category (frontend, backend, api, database, auth_security, repo_processing,
  llm_orchestration, token_usage, testing, configuration, performance, other), severity + the reason, confidence (0–1),
  evidence, file path and lines, suggested fix, validation steps, status, assignee, history.
* **Resumable**: the scan row records finished and failed batches; "Continue" and "Resume" run only the rest. A spent
  provider quota stops the scan instead of failing every batch. A rescan of a newer commit skips files whose content hash
  is unchanged since they were last scanned ("Scan changes only"), and says how many tokens that saved.
* A bug that comes back after being resolved is reopened by the scan.

Measured on the demo repository (`docs/demo/buggy-shop.zip`, 9 files): 3 batches, 5,768 input + 3,638 output tokens, 10
verified bugs (2 critical SQL injections, a missing authorization check, reflected XSS, a TypeError off-by-one, an
un-awaited `forEach(async …)`, an assertion-less test, …). Not found: the hard-coded secrets, the stock race in
`placeOrder`, coupons above 100%. The scan is a strong first pass, not a complete audit.

## 4. Assignment

* People eligible for a bug come from `list_bug_assignment_candidates` (database function): active members who can see
  the project and are not marked UNAVAILABLE in the workforce directory, with their skills, team, open bugs and open tasks.
* Manual: the admin picks from the ranked list; every candidate shows the reasons (skills for the category, language of the
  file, job title, on the project's team, workload, availability).
* Automatic: `planAutoAssignment` ranks by the same facts, assigns most severe bugs first and counts each assignment
  against the person's workload so a batch spreads out. Owners/admins are used only when no employee is eligible.
  **This is a deterministic ranking, not a model decision**; the AI classifies the bug, the ranking assigns it.
* `assign_bug` re-checks eligibility in the database, so a wrong client or ranking cannot assign someone who may not see
  the project. History is stored in `repository_bug_events` (who, when, manual/auto, reason, previous assignee).
* Notifications (existing in-app system): `bug.assigned`, `bug.unassigned`, `bug.blocked`, `bug.fix_proposed`,
  `bug.review_requested`, `bug.qa_requested`, `bug.resolved`, `bug.comment`, `bug.status`.

## 5. Bug workspace and the approval-based fix

The bug page has three panes: **details** (description, severity reason, quoted evidence, assignment, history, comments),
**code** (the stored text with the bug lines highlighted, and the task graph: the bug, its file, the symbols containing
it, imports / imported-by files with their other open bugs, and the applied fix) and **fix workflow**.

Stages: Detected → Triaged → Assigned → In progress → Fix proposed → Awaiting approval → Fix applied → Testing → Code
review → QA verification → Resolved, plus Rejected, Blocked, Reopened, Cancelled. The status machine is in SQL
(`private.bug_transition_ok`) and mirrored in `src/lib/bugs/model.ts`; a test fails if they differ.

1. **Plan** (`bug_fix_plan` AI job, assignee/admin, bug must be In progress): the model returns a summary, steps, risks,
   tests to run and line-range **edits**. An edit must quote the exact current text of the lines it replaces; otherwise it
   is rejected. The server applies the edits to the *stored* file text, builds a unified diff, and stores the proposal
   with the file's base hash and the patched content's hash (the database recomputes both).
2. **Decision** (a person, assignee/admin): approve, request changes, or reject (a reason is required for the last two).
   Nothing is applied before approval.
3. **Apply + validate** (on approval): the server re-applies the edits to what is stored *now* and records checks: patch
   applies and reproduces the proposal; syntax of each patched file with tree-sitter (TS/JS/Python/Java); scope (≤3 files,
   ≤200 lines); **tests are always SKIPPED and say so** (OneForAll never runs your tests). Passed → Fix applied; failed →
   back to In progress with the failures shown.
4. **Hand-off**: testing needs an applied, validated fix; code review needs written test evidence; QA and resolved need
   written outcomes and must be done by someone **other than the person who made the fix**; Resolved also needs an applied
   fix that passed validation. Reviewers are notified.
5. **No push**: the working copy is the stored snapshot overlay; the stored unified diff can be downloaded and applied in
   your own repository (`git apply`). OneForAll never writes to GitHub.

## 6. Permission matrix

| Action | Owner/Admin | Assignee | Other employee (sees project) | Employee elsewhere | Other organization |
| --- | --- | --- | --- | --- | --- |
| See graph, bugs, history, fixes | yes | yes | yes | no (404) | no (404) |
| Start a scan / cancel / resume | yes | no | no | no | no |
| Assign, reassign, unassign, auto-assign | yes | no | no | no | no |
| Start work, block, ask for a fix, approve/reject | yes | yes | no | no | no |
| Code review / QA / resolve | yes unless they made the fix | no (own fix) | yes | no | no |
| Reject as not a bug, cancel, reopen | yes | no | no | no | no |
| Comment | yes | yes | yes | no | no |

Enforced by RLS (reads) and `SECURITY DEFINER` functions (writes). Clients have no table write privileges on the bug tables.

## 7. Orchestrator and token optimisation (what is integrated)

* Only the existing Gemini provider is used (`GEMINI_API_KEY`; tiers `AI_MODEL_FAST` / `AI_MODEL_STANDARD`). There is no
  GPT/Claude/Groq fallback and none is claimed. Fallback goes down from the standard to the fast Gemini model and is
  recorded on the run.
* Bug scans and fix plans run through `runJob`, so they get the same state machine, deadline, retries, redaction of
  secrets before text leaves the server, untrusted-data wrapping, output-schema validation, and per-run usage / cost in
  `ai_runs`. They have their own daily limit (300 runs per 24 h) so a scan cannot use up the interactive 50.
* Token savers that are implemented: file filtering, priority ordering and caps; batching to a byte budget; imports given
  as one-line notes instead of file bodies; large files chunked; unchanged files skipped on rescans; fix plans read only
  the bug's neighbourhood; per-job token budgets; free-tier model by default. Measured numbers are in §3.

## 8. Light mode

`:root[data-theme="light"]` redefines the same design tokens (no component hard-codes colours). A script in `<head>`
sets the theme before first paint (no flash); the choice is stored in `localStorage` (`ofa-theme`), dark is the default.
Status colours are darker in light mode for contrast. Graph, bug workspace, badges and forms use the tokens.

## 9. Environment variables (names only)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or the publishable key), `STRUCTURE_PERSIST_KEY` (vault),
`GEMINI_API_KEY` (AI scans and fixes), optional `AI_MODEL_FAST` / `AI_MODEL_STANDARD` / `AI_MODEL_DEEP`, `APP_URL`
(links in emails and tunnels), `SMTP_USER` / `SMTP_PASSWORD` (invitation email), optional `GITHUB_TOKEN`-style
credentials are stored per project, never in `.env`. See `.env.example`.

## 10. Known limits (real, today)

* Tests are never executed; "validated" means: patch applies, syntax parses, scope is small. A person must test.
* Syntax validation covers TypeScript, JavaScript, Python and Java only.
* Import resolution is conservative: path aliases other than `@/` and `~/`, dynamic requires and Python namespace
  packages may be unresolved (the count of unresolved local imports is reported when links are rebuilt).
* A scan reads at most 40 files / 60 units; bigger repositories are scanned most-depended-on first, and the skipped files are listed.
* Recall is not complete (see §3); the AI can be wrong, which is why every fix needs a person's approval.
* Automatic assignment is a ranking over directory data (skills, team, workload); empty skills lower its quality.
* "Next team" hand-off notifies the project's reviewers (everyone else who can see the project), not a separate team entity.
* The fix proposal edits at most 3 files and 5 edits; larger refactors are out of scope by design.
* The first import of a snapshot made before this feature needs "Rebuild import links" once.

## 11. Tests

```bash
npm test                 # 343 unit tests (node:test via tsx)
npm run test:sql         # 25 SQL suites on an isolated schema copy
npm run lint
npm run typecheck
npm run build
```

New suites: `src/lib/bugs/*.test.ts` (model parity with SQL, scan planning, evidence verification, findings, ranking, patch
application and `git apply` round-trip, validation), `src/lib/project-graph/*.test.ts`, `src/server/bugs/runner.test.ts`
(resumable scheduling, deadline, quota stop, cancellation), `src/components/shell/theme-script.test.ts`, and
`supabase/tests/repository_{file_edges,bugs,bug_assignment,bug_fix_workflow}_rls.sql`.

## 12. Demo script (about 8 minutes)

Prerequisites: Docker running, `npm run db:start`, `.env.local` with `GEMINI_API_KEY`, then `npm run build && npm start`.

1. **Sign in** as the organization owner. Open Project → Repository → connect `https://github.com/sindresorhus/slash`
   leaving *Default branch* empty. Point out: "Detected automatically".
2. **Import without a SHA**: Project → Integrations → *Import latest from this branch*. Say what happens: branch resolved,
   exact commit recorded, files + text + symbols + import links stored.
3. **Project graph**: Snapshots → *View Project Graph*. Show real counts, expand folders, click a file (imports / imported
   by / symbols), search a symbol, toggle light mode with the sun/moon button.
4. **Bugs with evidence**: use the prepared *Buggy Shop* project (upload `docs/demo/buggy-shop.zip` on a snapshot, or
   import any repository with defects). Project → Bugs → *Scan this repository*; watch batches finish (~1 minute). Open the
   list: severities, categories, confidence. Open the SQL injection bug and show the quoted evidence.
5. **Assign**: *Reassign…* shows ranked people with reasons; or *Auto-assign* on the list. Show the history entry and the
   notification the assignee receives (My bugs).
6. **Workspace**: highlighted code, task graph (bug → file → symbols, imports, other bugs in neighbouring files).
7. **Approval-based fix**: *Start work* → *Generate AI fix plan* (~20–60 s). Read the plan and the diff, then *Approve and
   apply*; show validation (patch applies, syntax passes, **tests skipped**). Download the diff.
8. **Hand-off**: *Move to testing* (write what was run) → *Request code review*; sign in as another member to approve to QA
   and resolve with evidence. Show that the fixer cannot review or verify their own fix.
9. **Admin dashboard**: Organization → *Repos & bugs*: graphs per repository, approval queue, workload, AI usage.
