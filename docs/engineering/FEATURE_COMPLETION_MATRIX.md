# Feature completion matrix

Weighted, evidence-based completion of the prioritized core scope. The scope is Phase I as built plus the Phase II core
agreed for this pass: source content store, AI orchestrator and four AI jobs (Code Q&A, requirement ↔ code trace,
review / bug explain, tests / docs generation). Defect-risk prediction, CI/CD, webhooks and new git providers stay in
scope as P3 so they count against completion instead of disappearing.

**Formula:** `completion = Σ(weight × verified_fraction) / Σ weight`, with weight 3 for P0/P1, 2 for P2, 1 for P3.
A fraction above 0 needs evidence; "verified" needs an executed test or an observed end-to-end run.

**Status values:** Verified, Partial, Broken, Missing, Blocked, Not applicable.

## Baseline (2026-10-26, commit `092b9f4`)

| # | Feature | P | Status | Fraction | Evidence / existing implementation | Remaining gaps |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Sign-up, sign-in, session, route guard | P1 | Verified | 1.0 | `src/server/auth`, `src/proxy.ts`; observed this session | Email confirmation off locally |
| 2 | Organizations, departments, teams, projects, roles | P1 | Verified | 1.0 | SQL suites organizations, departments, teams, projects (19/19) | none |
| 3 | Members and invitations (email delivery) | P1 | Verified | 1.0 | `members_invitations_rls.sql`; Gmail delivery and acceptance observed | none |
| 4 | Requirements and tasks with SDLC/QA workflow | P1 | Verified | 0.9 | SQL `requirements_tasks`, `task_workflow`, `sdlc_qa`; unit `workflow.test.ts` | UI flows only verified by harnesses not in repo |
| 5 | Repository connection, snapshots, ZIP ingestion | P1 | Verified | 1.0 | `sources.test.ts`, manifest SQL suites | none |
| 6 | GitHub import at exact commit | P1 | Partial | 0.8 | public import verified (handover); `integrations.test.ts` | private-token import **blocked** (no token) |
| 7 | Structure analysis (TS/JS/Py/Java) | P1 | Verified | 1.0 | `repository_structure_rls.sql` | file-local relationships only (see #27) |
| 8 | Repository graph (overview, file, search, focus) | P1 | Verified | 1.0 | `graph.test.ts`, `explore.test.ts`, `repository_graph_read_rls.sql` | none |
| 9 | Dependency and HTTP security baseline | P0 | Broken | 0.3 | `npm audit`: 1 critical, 3 high; no security headers | upgrade, headers |
| 10 | Source content store (read code of a snapshot) | P1 | Missing | 0 | content discarded (`source.ts`) | table, write path, read path, code search |
| 11 | AI orchestrator (routing, budget, tools, states, retries, persistence) | P1 | Missing | 0 | none | all |
| 12 | Code Q&A with citations | P1 | Missing | 0 | none | all |
| 13 | Requirement ↔ code trace | P1 | Missing | 0 | none | all |
| 14 | Code review / bug explain | P1 | Missing | 0 | none | all |
| 15 | Tests / docs generation (validated, not applied) | P1 | Missing | 0 | none | all |
| 16 | Workforce directory, CSV import/export, assignment | P2 | Verified | 1.0 | `workforce_directory_rls.sql`, csv/assignment unit tests | none |
| 17 | Notifications and My work | P2 | Verified | 1.0 | `task_workflow_rls.sql`, `sdlc_qa_rls.sql` | in-app only |
| 18 | Jira Cloud one-way sync | P2 | Blocked | 0.5 | mocked unit tests, `project_integrations_rls.sql` | needs a real Jira site |
| 19 | Token budgeting and usage/cost accounting | P2 | Missing | 0 | none | all |
| 20 | Observability (health, structured logs, correlation ids) | P2 | Missing | 0.1 | ad-hoc `console.error` in 4 places | all |
| 21 | Test tooling (`npm test`, SQL runner, CI) | P2 | Partial | 0.6 | `npm test`, `npm run test:sql` added this phase | no CI, no HTTP/browser harness in repo |
| 22 | AI evaluation suite | P2 | Missing | 0 | none | all |
| 23 | Engineering docs and diagrams | P2 | Partial | 0.5 | 8 docs in `docs/`, 7 PNG diagrams | AI, architecture, test, security docs |
| 24 | Defect-risk prediction | P3 | Missing | 0 | none | model, data, UI |
| 25 | Webhooks and scheduled re-ingestion | P3 | Missing | 0 | none | all |
| 26 | GitLab, Bitbucket, GHES sources | P3 | Missing | 0 | none | all |
| 27 | Cross-file symbol resolution | P3 | Missing | 0 | file-local edges only | resolver |
| 28 | Account / profile settings page | P3 | Missing | 0 | dead "Settings — SOON" control | page |

### Baseline score
| Priority | Features | Weight each | Σ weight | Σ weight × fraction |
| --- | --- | --- | --- | --- |
| P0/P1 | #1–#15 | 3 | 45 | 3 × 8.0 = 24.0 |
| P2 | #16–#23 | 2 | 16 | 2 × 3.7 = 7.4 |
| P3 | #24–#28 | 1 | 5 | 0 |
| **Total** | 28 | | **66** | **31.4** |

**Baseline completion: 31.4 / 66 = 47.6 %.**

Reaching 85 % needs 56.1 points. Completing #9–#15 adds 20.1 (to 51.5 = 78.0 %); bringing #19–#23 to verified adds up
to 7.6 more (about 89 %). #6 and #18 stay partly blocked on credentials. This matrix is re-scored with evidence at the
end of the work in `FINAL_COMPLETION_REPORT.md`.
