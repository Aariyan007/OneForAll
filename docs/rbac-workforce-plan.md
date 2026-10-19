# RBAC, workforce and SDLC: audit and implementation plan

Status: Phase 0 audit (2026-10-18). Baseline: branch `main`, HEAD `1e287c3`. Uncommitted work from the GitHub-import fix
is present (8 modified files plus `src/server/integrations/repository-state.ts`). Local database: 3 auth users, 2 of them
OWNER of 3 organizations (one user owns two), 1 user with no organization. 3 departments, 3 teams, 5 projects,
1 requirement, 1 task. No department or team members, ADMINs, MEMBERs or invitations exist.

## 1. What already exists and is reused

| Area | Where | Notes |
| --- | --- | --- |
| Identity | Supabase Auth; `src/server/auth/{actions,session}.ts`; `src/lib/supabase/proxy.ts` | email/password sign-up and sign-in, `getUser()` per request, proxy redirect for signed-out users. Session persistence and logout work. |
| Profiles | `public.profiles` (migration `20261007000001`) | created by trigger on `auth.users`. **Visible only to the owner**; no co-member visibility. |
| Organizations and roles | `organizations`, `organization_members(role in OWNER/ADMIN/MEMBER)` (`20261008000001`) | per-organization role (a user can hold different roles in different organizations). `is_org_member()` / `has_org_role()` are the central SECURITY DEFINER helpers used by every policy. `create_organization()` creates the organization and the OWNER membership atomically. |
| Hierarchy | departments, `department_members`, teams, `team_members`, projects (`20261009`–`20261011`) | writes are OWNER/ADMIN; project visibility is OWNER/ADMIN or team member. `addDepartmentMember`/`addTeamMember` Server Actions exist but **no UI uses them**. |
| Requirements and tasks | `20261012000001`; `src/server/{requirements,tasks}` | lifecycle triggers; writes OWNER/ADMIN only. **No assignee**, no skills, effort, dependencies, comments or activity. Status Server Actions exist but **no UI uses them**. |
| Tenant context | `getTeamContext()`, `getProjectContext()`, `getIntegrationContext()` | verify org → department → team → project from the database, 404 on mismatch. The active organization is the URL path (`/organizations/<id>/…`); the sidebar selector links between organizations; no client-side organization state to clear. |
| Repository intelligence | migrations `20261013`–`20261021`, `src/server/repository-*`, graph routes | unchanged by this work. |
| Tests | `supabase/tests/*_rls.sql` (rolled-back transactions, fixture UUIDs), `node:test` unit tests compiled with `tsc`, HTTP/CDP harnesses (scratch, not in repo) | new work follows the same conventions. |

## 2. Gaps (security and product)

1. **No way to add members.** `organization_members` has no client write path and there are no invitations, so an
   organization can only ever contain its creator. ADMIN and MEMBER roles exist but cannot be granted.
2. **No role management or removal**, no audit trail of membership changes.
3. **Co-member profiles are invisible** (policy `profiles_select_own` only), so a member list or an assignee picker
   cannot show names.
4. **Permissions are scattered**: `CAN_MANAGE = ["OWNER","ADMIN"]` in several files; no central matrix.
5. **No workforce data** (job title, skills, availability), no directory import.
6. **Tasks cannot be assigned**, members cannot update any task (all task writes are OWNER/ADMIN), no blocked/review
   states, no dependencies, comments, activity, handoffs or notifications.
7. Users with no organization see an empty dashboard (fine) but have no way to see a pending invitation.
8. `listMyOrganizations()` returns one row per visible membership (documented in memory; de-duplicated in
   `src/lib/workspaces.ts`).

Not gaps: tenant isolation of existing tables is enforced by RLS and covered by the SQL suites; revoked membership takes
effect on the next request because every page and policy re-reads membership.

## 3. Design decisions

- **One role source**: `organization_members.role` stays the only role. "Employee" in the UI = `MEMBER`.
- **Central matrix** `src/server/authz/permissions.ts` (pure, unit-tested) mirrors the database rules; the database
  (RLS + SECURITY DEFINER functions with explicit `auth.uid()` checks) stays the authority.
- **Admin scope**: ADMIN is organization-wide (the existing schema has no per-department admin scope). Documented;
  narrower scope is future work.
- **Owner safeguards**: no one can change or remove an OWNER membership or their own role; ownership transfer and
  organization deletion are out of scope.
- **Invitations**: token generated server-side in the database, only its SHA-256 stored; bound to organization, email
  and role; 7-day expiry; single use; ADMIN may invite MEMBER only, OWNER may invite ADMIN or MEMBER. **No email
  provider is configured**, so the inviter copies a one-time link from the UI (documented).
- **Workforce directory** `workforce_profiles` keyed by (organization, email), optionally linked to a member user;
  normalized `skills` per organization; availability `AVAILABLE | BUSY | UNAVAILABLE`. CSV import never creates auth
  accounts, never grants roles; a `role` column is rejected.
- **Tasks**: additive columns (`assignee_id`, `acceptance_criteria`, `estimated_hours`, `due_date`), required skills,
  dependencies, events, comments, handoffs, in-app notifications. Statuses extended additively:
  `TODO, IN_PROGRESS, BLOCKED, IN_REVIEW, COMPLETED, CANCELLED` (all existing rows stay valid).
- **Assignment**: deterministic ranking in TypeScript (pure, unit-tested); the database function `assign_task` validates
  eligibility and does a compare-and-set on the current assignee (concurrency). Modes per organization: `MANUAL`
  (default for every existing organization), `RECOMMEND`, `AUTO` (explicit opt-in by an OWNER).

## 4. Migrations (new, additive)

1. `20261022000001_members_invitations.sql`: co-member profile visibility, `organization_invitations`,
   `organization_audit_events`, RPCs `create_organization_invitation`, `revoke_organization_invitation`,
   `get_invitation_preview`, `accept_organization_invitation`, `change_member_role`, `remove_organization_member`.
2. `20261023000001_workforce_directory.sql`: `workforce_profiles`, `skills`, `workforce_profile_skills`, membership
   linking, `import_workforce_directory`, profile update functions.
3. `20261024000001_task_assignment_workflow.sql`: task columns and statuses, `task_required_skills`,
   `task_dependencies`, `task_events`, `task_comments`, `task_handoffs`, `notifications`, `organization_settings`,
   RPCs for assignment, status transitions, dependencies, comments, handoffs, notifications.

## 5. Phases

| Phase | Scope | Verification |
| --- | --- | --- |
| 1 | permission matrix + `getOrgAccess()`; replace scattered role checks | unit tests; existing suites |
| 2 | role-aware navigation, no-organization onboarding with pending invitations, organization switching via URL | HTTP checks |
| 3 | migration 1; Members page (list, roles, remove, invitations); invitation accept page | SQL suite `members_invitations_rls.sql`; HTTP |
| 4 | CSV templates, parser/validator, preview, confirmed import | unit tests (parser), SQL suite, HTTP |
| 5 | Workforce page (skills, availability, workload), own-profile editing | SQL suite, HTTP |
| 6–8 | migration 3; task detail page: assignment, recommendations, status workflow, dependencies, comments, handoffs; notifications | unit tests (ranking, transitions), SQL suite `task_workflow_rls.sql`, HTTP, browser |
| 9 | My Work (employee), role-aware workspaces | HTTP, browser |
| 10 | full regression: unit, SQL, typecheck, lint, build, graph/ingestion harnesses | report |

Progress and deviations are recorded at the end of this file as phases complete.

## Progress (2026-10-18)

| Phase | Status |
| --- | --- |
| 0 Audit and plan | done (this file) |
| 1 Authorization foundation | done: `src/lib/authz/permissions.ts`, `src/server/authz/access.ts`; scattered role checks replaced; organization list filtered by user |
| 2 Login and organization selection | done within the existing URL-based model: role-aware navigation (Members, Workforce, My work, Notifications), no-organization onboarding with pending invitations. No separate selector page: the sidebar selector and dashboard list the caller's organizations |
| 3 Members and invitations | done (migration `20261022000001`) |
| 4 CSV directory | done (migration `20261023000001`, `src/lib/workforce/csv.ts`) |
| 5 Workforce profiles | done |
| 6 Manual assignment | done (migration `20261024000001`) |
| 7 Intelligent assignment | done: deterministic ranking, recommend and opt-in automatic modes |
| 8 Workflow, dependencies, handoffs, activity, notifications | done (in-app notifications only) |
| 9 Role-specific UI | done: Members, Workforce, task page, My work, Notifications, collaborating teams on the project page |
| 10 Verification | done; see docs/rbac-workforce.md and the final report |

Deviations: ADMIN scope is organization-wide (no per-department scope in the schema). Invitations are delivered by
copying a one-time link (no email provider). Server Actions of these features reload the page instead of
`revalidatePath` (see docs/rbac-workforce.md, section 7).

## Audit reconciliation (2026-10-18, second pass)

The table above says "done" for every phase. This pass re-checked the claim against the code, the local database and
the contract's acceptance criteria. Result: phases 1 to 9 are implemented but **not complete against the contract**.
The gaps are listed below.

### Baseline
- Branch `main`, HEAD `1e287c3`. Nothing is staged or committed.
- All RBAC/workforce work is uncommitted:
  - 60 modified tracked files (earlier tasks included);
  - 52 untracked files, among them the five migrations `20261022000001` to `20261025000001`.
- Local migrations applied: `20261007000001` to `20261025000001`. No hosted database was touched.
- Real local data after fixture cleanup:
  - 3 auth users, 3 organizations, 3 memberships (all OWNER);
  - 3 departments, 3 teams, 5 projects, 4 repositories, 4 snapshots, 1 requirement, 1 task;
  - 2 GitHub integrations without tokens, 1 Vault secret.
  - Migration `20261023000001` backfilled 3 `workforce_profiles` rows (source `MEMBERSHIP`), one per existing member.
  - These counts match the Phase 0 baseline plus that backfill.

### Architecture as found (real objects)
- **Authentication:**
  - Supabase Auth with email and password: `src/server/auth/{actions,session}.ts`, callback `src/app/auth/callback/route.ts`.
  - Signed-out redirect in `src/lib/supabase/proxy.ts`.
  - The profile is created by trigger `on_auth_user_created` → `public.handle_new_user()`.
- **Membership and roles:**
  - `organization_members(role in OWNER, ADMIN, MEMBER)` is the only role source.
  - `department_members` and `team_members` carry no role.
  - Invitations: `organization_invitations(role in ADMIN, MEMBER, token_hash, status, expires_at)`.
- **Authorization:**
  - Matrix: `src/lib/authz/permissions.ts`.
  - Organization access: `src/server/authz/access.ts` (`getOrgAccess`).
  - Context chains: `getTeamContext` / `getProjectContext` / `getTaskContext`, which call `requireUser()`.
  - RLS on all 32 public tables (63 policies) and SECURITY DEFINER RPCs.
  - Every exported Server Action and all 7 route handlers verify the session (checked file by file).
- **Work model:**
  - `requirements`, and `tasks` with `assignee_id, team_id, acceptance_criteria, estimated_hours, due_date`.
  - Statuses `TODO, IN_PROGRESS, BLOCKED, IN_REVIEW, COMPLETED, CANCELLED`.
  - Tables `task_dependencies`, `task_events`, `task_comments`, `task_handoffs`, `notifications`, `project_teams`, `organization_settings`.
- **UI routes** (beyond the existing hierarchy, repository and graph pages):
  - `/organizations/[id]/members`, `/organizations/[id]/workforce`, `/organizations/[id]/workforce/import`;
  - `…/tasks/[taskId]`, `/my-work`, `/notifications`, `/invitations`.
- **Tests:**
  - 17 SQL suites in `supabase/tests` (rolled back).
  - 12 `node:test` files.
  - Scratch HTTP and CDP harnesses (not in the repository).

### Phase status against the contract

| Phase | Status | Evidence / gap |
| --- | --- | --- |
| 1 Authorization foundation | **complete after this pass** | Grant audit found Supabase default grants on `profiles`: anon SELECT/TRUNCATE/REFERENCES/TRIGGER, authenticated TRUNCATE/REFERENCES/TRIGGER, and the definer trigger functions executable by PUBLIC. Revoked by `20261025000001_client_privilege_hygiene.sql`. Guarded by `supabase/tests/privilege_grants_rls.sql`, a global catalog check. |
| 2 Login and organization selection | complete within the URL model | **Deferred:** suspended accounts. The schema has no suspension state; adding one is a product decision. |
| 3 Members and invitations | partial → search added | **Done in this pass:** member search and role filter (contract 7.4). **Open:** suspension (no schema); department/team assignment is done through the workforce directory entry, not the member list. |
| 4 CSV directory | complete for employees | **Open:** `departments-template.csv` and `teams-template.csv` (contract 8.1, "where appropriate"). |
| 5 Workforce profiles | complete | No timezone/working hours (contract: only "if the product needs it"). |
| 6 Manual assignment | complete | — |
| 7 Intelligent assignment | partial | **Open:** re-evaluation when a task is unassigned, declined or blocked (10.3 step 13). Scheduling and deadline constraints are not used in ranking. |
| 8 Workflow, handoffs, notifications | partial | **Open:** QA/testing/release stages (contract 11, Scenario D steps 8–10); the lifecycle ends at `IN_REVIEW` → `COMPLETED`. No defect records. No mention, deadline or invitation-accepted/expired/revoked notifications. Handoffs do not create a receiving task. No repository or PR references on tasks. |
| 9 Role-specific UI | partial | **Open:** organization overview and settings pages (13.2); My work lacks "Upcoming", "Blocked" and "Completed" groups (13.4); Admin scope is organization-wide (5.2 asks for narrower scope "where the data model allows it"; it does not). |
| 10 Verification | ongoing | See the final report of each pass. |

### Fixed in this pass
- **Navigation regression fix** (not an RBAC phase): see docs/rbac-workforce.md, section 7.
  - Duplicate submissions while the next page loads are now blocked: `untilPageUnload` in `src/components/ui/reload.ts`.
  - Redirect targets are validated as same-origin: `src/lib/navigation.ts`, unit-tested.
- **Two SQL suites assumed an empty database:** `repositories_rls.sql` and `repository_snapshots_rls.sql` counted every repository and snapshot after their cascade test, so they failed once real data existed. They now count only their own fixture rows.

### Next phases, in order
1. Phase 4 completion: departments and teams CSV templates, using the same import service and checks.
2. Phase 7: re-evaluating assignment on unassign, decline or block, by explicit policy and without silent changes.
3. Phase 8, largest:
   - QA/testing/release states, as an additive status migration with explicit transitions;
   - defect records;
   - notifications for invitations, mentions and deadlines.
4. Phase 9: organization overview and settings pages; the missing My work groups.
5. Decisions needed from the product owner before building:
   - account suspension;
   - narrower Admin scope (a schema change).

## Completion pass (2026-10-19)

Work done after the second audit, in contract order. Migrations `20261026000001` and `20261027000001` were applied to
the local database only. Behaviour and evidence: [rbac-workforce.md](rbac-workforce.md).

| Phase | Status | What closed the gap / how it was verified |
| --- | --- | --- |
| 0 Audit and baseline | COMPLETE AND VERIFIED | Audit sections above; data counts re-checked after every fixture cleanup |
| 1 Authorization foundation | COMPLETE AND VERIFIED | Grant hygiene (`20261025000001`); every Server Action and route handler checks the session; `privilege_grants_rls.sql` covers all tables and SECURITY DEFINER functions |
| 2 Login and organization selection | COMPLETE AND VERIFIED | Different roles in two organizations (HTTP); suspension and revocation take effect on the next request; the dashboard explains suspended access; role-aware navigation (Settings) |
| 3 Members and invitations | COMPLETE AND VERIFIED | Search, role and status filters; suspend/reactivate (owner: admins and employees, admin: employees); inviter notified on accept, revoke and expiry; expiry closed on page load |
| 4 CSV workforce directory | COMPLETE AND VERIFIED | Departments and teams templates and import (preview, hash-confirmed apply, row errors, people columns refused); unit, SQL and browser tests |
| 5 Workforce profiles | COMPLETE AND VERIFIED | Unchanged since the first pass; regression suites pass |
| 6 Manual task assignment | COMPLETE AND VERIFIED | Only active members are eligible; in-QA tasks cannot be reassigned |
| 7 Intelligent assignment | COMPLETE AND VERIFIED | Decline before starting; unassigned tasks return to the overview queue; AUTO queue run; managers notified when nobody is eligible. Rule documented: blocked tasks are not reassigned automatically |
| 8 SDLC workflow and handoffs | COMPLETE AND VERIFIED | `IN_QA` stage and per-task QA policy, testers, defects, requirement completion rule, mentions, deadline notifications (generated on page load: no scheduler), links, due-date and QA-policy activity |
| 9 Role-specific UI | COMPLETE AND VERIFIED | Organization overview (manager and employee views), settings page, My work (To review, To test, Up next, Upcoming, In QA, …), task page (defects, links, decline, mentions, QA policy), requirement status |
| 10 Verification | COMPLETE AND VERIFIED | Typecheck, lint, build; 168 unit tests; 18 SQL suites (one on an isolated schema copy); browser and HTTP acceptance and regression suites, listed in the final report |

Blocked or deferred (not silently skipped):
- **Email delivery: BLOCKED.** No email provider is configured, so invitations use a copied one-time link. Every notification is in-app only.
- **Per-department/team admin scope: DEFERRED.** The data model has no scoped admin role (`department_members` and `team_members` carry no role). Adding one changes every policy that grants admin access; it needs a product decision.
- **Account-wide suspension: not built.** Suspension is per organization membership, which is what the authorization model uses.
- **Ownership transfer and organization deletion: not built.** They are destructive; the contract requires dedicated safeguards.
- **Receiving task on handoff: not built.** The same task moves to the receiving team with its history.
