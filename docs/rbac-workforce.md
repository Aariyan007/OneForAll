# Organization access, workforce, assignment and task workflow

What exists, how it is enforced and how it was tested. Plan, audit and phase status: [rbac-workforce-plan.md](rbac-workforce-plan.md).

## 1. Authentication and the active organization
- **Identity:** Supabase Auth (email and password), unchanged. Sign-up creates a profile only (trigger `handle_new_user()`); it never creates a membership or a role.
- **Active organization:** the URL (`/organizations/<id>/…`).
  - Every page and action resolves the caller's membership of that organization from the database (`getOrgAccess()` in `src/server/authz/access.ts`).
  - A forged id, another tenant, a revoked membership or a suspended membership all give the not-found page.
  - The sidebar selector, the dashboard and the command palette link to each organization's **Overview**.
  - There is no client-side organization or role state to clear when switching.
- **Several organizations:** the role is per membership. The same account can be an owner in one organization and an employee in another. Pages and navigation follow the role of the organization in the URL.
- **No organization:** the dashboard offers "create an organization" (you become its owner) and lists pending invitations addressed to your email. Joining needs the invitation link.
- **Suspended membership:** the dashboard names the organizations where the caller is suspended (`list_my_suspended_memberships()`). Those organizations' pages are not available.
- **Not implemented:** ownership transfer and deleting an organization. Both are destructive and need safeguards; the settings page says so.

## 2. Roles and permissions
One role per membership in `organization_members.role`. "Employee" in the UI is the `MEMBER` role. A membership is `ACTIVE` or `SUSPENDED` (`organization_members.status`).

The matrix lives in `src/lib/authz/permissions.ts` (unit-tested) and **mirrors** the database. The database is the authority: RLS, plus SECURITY DEFINER functions that check `auth.uid()` themselves.

| Capability | Owner | Admin | Employee |
| --- | --- | --- | --- |
| See the organization, members, co-member names | yes | yes | yes |
| Organization overview | queue, workload, activity | queue, workload, activity | own work, structure |
| Settings page (name) | yes | yes | no |
| Assignment policy (manual / recommend / auto) | yes | read only | no |
| Manage departments, teams, projects, collaborating teams; structure CSV | yes | yes | no |
| Invite | admins and employees | employees only | no |
| Change roles (Admin ↔ Employee) | yes, not on an owner or oneself | no | no |
| Suspend / reactivate | admins and employees | employees | no |
| Remove a member | admins and employees | employees | only oneself (leave) |
| Workforce directory, import, export, skills vocabulary | yes | yes | own entry only |
| Own availability and skills | yes | yes | yes |
| Create, plan and assign tasks; review; cancel; reopen; QA policy | yes | yes | no |
| Work a task assigned to them (start, block, resume, submit, stop, decline before starting) | yes | yes | yes |
| Test a task in QA (pass, fail, report defects) | yes | yes | if in the responsible team and not the assignee |
| Resolve a defect | yes | yes | if assignee |
| Add links to a task | yes | yes | if assignee |
| Comment and mention people who can see the task | yes | yes | yes |
| Hand off a task | yes | yes | if assignee |
| Accept/decline a handoff to their team | yes | yes | if member of the receiving team |
| Membership audit trail | yes | yes | no |

- **Admin scope is organization-wide.** The schema has no per-department admin scope. Adding one is a schema change and a product decision; see the plan.
- **Owner safeguards:**
  - Nobody can change, suspend or remove an owner membership.
  - Nobody can change their own role or suspend themselves.
  - Nobody can invite an owner or make someone owner.
- **Project visibility:** owners/admins, members of the project's team, and members of a **collaborating team** (`project_teams`). All of them must hold an **active** membership.

### How suspension is enforced
- `is_org_member()`, `has_org_role()`, `private.caller_org_role()`, `shares_organization()` and `private.user_can_see_project()` count `ACTIVE` memberships only (migration `20261026000001`).
- Every RLS policy and SECURITY DEFINER function goes through these helpers, directly or through departments, teams and projects RLS. A suspended person therefore loses all access to the organization on their next request.
- On suspension:
  - their open tasks there are unassigned and logged;
  - their role and team memberships are kept, so reactivation restores the same access;
  - an invitation never reactivates a suspended membership.

## 3. Members and invitations
- **Members page** `/organizations/<id>/members`:
  - people, with roles (owner-editable), suspension state, Suspend/Reactivate, Remove/Leave;
  - pending invitations with revoke, recent closed invitations, membership activity.
- **Search and filters** (`?q=`, `?role=`, `?status=`): a plain GET form, filtered on the server by `src/lib/members/filter.ts`. It narrows only the list the caller may already see; unknown values are ignored.
- **Invitations:**
  - `create_organization_invitation()` makes a 256-bit token; only its SHA-256 is stored.
  - Each invitation is bound to an organization, an email, a role and the inviting actor.
  - It expires after 7 days, works once, can be revoked, and only one may be pending per address.
- **No email provider is configured.** The inviter copies a one-time link (`/invitations#<token>`) and sends it. The token is in the URL fragment, which browsers never send to a server.
- **Accepting:** `accept_organization_invitation()` checks the token, the status, the expiry and that the signed-in email equals the invited email. It then creates the membership and consumes the invitation atomically.
- **Invitation notifications** (in-app, to the inviter):
  - accepted;
  - revoked by someone else;
  - expired.
- **Expiry:** there is no scheduler. `close_expired_invitations()` marks expired invitations `EXPIRED` and notifies the inviter once. It runs when an owner or admin opens the members or overview page.
- **Audit** (`organization_audit_events`, owners and admins):
  - invitations, revocations, expiries, joins, role changes, suspensions, reactivations, removals;
  - directory and structure imports, profile edits, policy changes, collaborating-team changes.

## 4. Workforce directory and organization structure
- `workforce_profiles`: one entry per person and organization, keyed by email, linked to the account when that person is a member.
  - Fields: full name, employee code, job title, home department/team, availability (`AVAILABLE`, `BUSY`, `UNAVAILABLE`).
- Skills: a normalized vocabulary per organization (`skills`) and `workforce_profile_skills`.
- Joining links the existing entry and applies its home department/team. Leaving unlinks the account and keeps the entry.
- **Workforce page** `/organizations/<id>/workforce`:
  - everyone: own availability and skills;
  - owners and admins: the directory with workload, entry editing, the skill vocabulary.

### CSV import (`/organizations/<id>/workforce/import`)
- **Templates** at `/organizations/<id>/workforce/template`, fictional rows only:
  - employees (default): `full_name,email,employee_code,department,team,job_title,skills,availability`;
  - `?kind=departments`: `name,description`;
  - `?kind=teams`: `department,name,description`.
- **Flow** (both imports): upload (UTF-8, at most 512 KiB and 2,000 rows), then a dry-run preview by the database, then confirm.
  - Confirming re-sends the exact previewed text, which must match its hash. For structure imports the hash includes the kind.
  - Valid rows are written in one transaction; invalid rows are skipped and reported.
- **Employee rules:**
  - People are matched by email. Empty cells keep current values. Skills are added, never removed.
  - Departments and teams are matched by name in the organization.
  - Duplicate emails and duplicate employee codes in the file are rejected.
  - **Never** creates accounts, invitations or roles. A `role`, `password`, `token`, `user_id` or `organization_id` column makes the whole file invalid.
- **Structure rules** (`import_organization_structure()`):
  - Names are matched case-insensitively, teams within their department.
  - Existing entries are unchanged; a non-empty, different description updates them.
  - A team's department must exist; duplicates in the file are errors.
  - People columns (`email`, `role`, …) make the file invalid. Nobody is added to a department or team.
- Export: `/organizations/<id>/workforce/export` (owners and admins). Values that start like a spreadsheet formula are prefixed with `'`.

## 5. Task assignment
- **Task fields:** assignee, acceptance criteria, estimate (hours), due date, responsible team, required skills, **QA required**, links.
- **Workload:**
  - active tasks (`TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `IN_QA`), their summed estimate, tasks without an estimate, blocked and overdue counts (`organization_workload()`);
  - completed and cancelled tasks never count; subtasks do not exist, so nothing is double-counted.
- **Eligibility** (database, `assign_task()`):
  - an **active** member who can see the project and is not `UNAVAILABLE`;
  - in-review, in-QA, completed and cancelled tasks cannot be reassigned;
  - reassigning a task in progress returns it to `TODO`.
- **Concurrency:** `assign_task()` locks the task and compares the current assignee with the one the caller saw. On a mismatch it fails with 40001 and changes nothing.
- **Ranking** (`src/lib/workforce/assignment.ts`, deterministic, unit-tested):
  - excluded: unavailable people; people with none of the required skills; for automatic assignment, people whose load would exceed 40 h;
  - order: skill coverage; not overloaded; `AVAILABLE` before `BUSY`; effective load (unestimated = 4 h); active tasks; team membership; user id;
  - every candidate shows the reasons for their position.
- **Modes** (`organization_settings.assignment_mode`, set on the **Settings** page by an owner; existing organizations start as `MANUAL`):
  - `MANUAL`: managers choose; eligibility, skills and workload are shown.
  - `RECOMMEND`: the top-ranked person is preselected and confirmed by a manager.
  - `AUTO`: "Assign automatically" on a task, or "Assign queue automatically" on the overview for up to 25 unassigned tasks not yet started. Tasks without required skills are refused: nothing shows who is qualified.
- **No eligible person:** the task stays unassigned, the caller sees why, and the other owners and admins get a `task.unassignable` notification (once per task per day).
- **Declining:** the assignee can decline a task they have not started, with a reason (`decline_task_assignment()`).
  - The task returns to the **assignment queue** on the overview.
  - Whoever assigned it and the organization's managers are notified.
- **Re-evaluation:** a task that becomes unassigned (declined, member suspended or removed) appears in the overview's queue.
  - In `AUTO` mode, "Assign queue automatically" re-runs the ranking for it.
  - A blocked task is not reassigned automatically: the blocker is usually not the assignee's fault. Managers are notified and the task appears under "Blocked and overdue".

## 6. Task workflow
- **Statuses:** `TODO`, `IN_PROGRESS`, `BLOCKED`, `IN_REVIEW`, `IN_QA`, `COMPLETED`, `CANCELLED`. Existing rows stay valid.
- **Transitions** (database trigger):
  - TODO → In progress or Cancelled.
  - In progress → Blocked, In review, Completed (managers, only without QA), To do or Cancelled.
  - Blocked → In progress or Cancelled.
  - In review → In QA ("Send to QA"), Completed ("Approve", only without QA), In progress (changes requested) or Cancelled.
  - In QA → Completed ("Pass QA"), In progress ("Fail QA", with what failed) or Cancelled.
  - Completed → In progress (reopen, also when a defect is reported).
  - Cancelled → To do.
- **Who** (`transition_task()`):
  - The assignee: start, block, resume, submit for review, stop work.
  - Testers: pass or fail QA. A tester is a member of the task's responsible team other than the assignee; after a handoff to a QA team, that team.
  - Owners and admins: every step.
  - Blocking, cancelling, requesting changes and failing QA need a reason.
  - A task cannot start unassigned, or start, go to review, QA or completion while a dependency is unfinished.
  - With **QA required** it can only be completed by passing QA.
  - It cannot enter QA or be completed while a defect is open.
- **Defects** (`task_defects`):
  - Testers report defects (title, severity LOW to CRITICAL, steps) on tasks in QA or completed tasks. Reporting sends the task back to the assignee (`IN_PROGRESS`).
  - The assignee or a manager resolves them with an optional note; the reporter is notified.
- **Links** (`task_links`): https links to pull requests, commits or documents. The assignee or managers add them; they open with `rel="noopener noreferrer"`.
- **Requirements:** owners and admins move a requirement through Draft → Ready → In progress → Completed (or Cancelled) on its page. A requirement can be completed only when every task is completed or cancelled (release readiness, enforced by trigger).
- **Dependencies:** same project only, cycles refused, at most 50 per task, managed by owners and admins.
- **Activity** (`task_events`): creation, status changes (with reason), assignments, declines, comments (with mentions), dependency and skill changes, handoffs, defects reported and resolved, due-date changes, QA policy changes, links.
- **Handoffs:**
  - The assignee or a manager hands a task to another team working on the project, with completed work, remaining work and notes.
  - Members of the receiving team accept (optionally taking the task) or decline; the creator or a manager can cancel.
  - Accepting makes the receiving team responsible, so a QA team becomes the tester.
  - The same task moves between teams with its whole history; no copy is created.
- **Notifications** (in-app only, deduplicated per event, only to people who can see the task, never to the actor):
  - assignments: assigned, unassigned, assignment declined, nobody eligible;
  - work: blocked, review requested, changes requested, review approved (now in QA), QA requested, failed QA, completed, ready to start;
  - defects: reported, resolved;
  - collaboration: comment, mentioned, handoff, handoff accepted or declined;
  - deadlines: due within two days, overdue;
  - organization: invitation accepted, revoked or expired; access restored.
  - **Deadlines** have no scheduler: `generate_deadline_notifications()` runs for the signed-in person on each page load (app layout), once per task and due date.
  - **No email or push delivery exists.**

## 7. Workspaces
- **Overview** `/organizations/<id>/overview`:
  - owners and admins: open, unassigned, blocked and overdue counts; the assignment queue (with the AUTO run); blocked and overdue tasks; review and QA; pending handoffs; workload per person; recent activity;
  - employees: their open tasks in that organization and the structure.
- **Settings** `/organizations/<id>/settings` (owners and admins): rename, assignment policy (owners edit, admins read), links to members, workforce, import and departments. The Settings link is hidden from employees in the navigation; the page returns not-found for them anyway.
- **My work** `/my-work`:
  - To review (managers), To test (testers), handoffs to my teams;
  - In progress, Blocked, Up next (ready), Upcoming (waiting on dependencies), In review, In QA, Completed.
- **Task page:** what to do and why (requirement), acceptance criteria, required skills, status actions with explanations, decline, defects, links, dependencies, handoffs, comments with mentions, activity; for managers, assignment and planning (estimate, due date, QA required, skills).

## 8. Known limitations
- **Page refresh after a change.** On Next.js 16.2.9, applying a page that a Server Action re-renders (`revalidatePath`) or redirects to (`redirect()`) was observed to leave the client transition pending; `router.refresh()` too.
  - Evidence:
    - a role change hung 3 of 4 times with `revalidatePath`;
    - create department settled 2 of 12 times with `redirect()`, create project 0 of 3.
  - Therefore no Server Action the UI uses calls `revalidatePath` or `redirect()`. Changes reload the page; creates return `redirectTo`, which opens with a full page load (`src/components/ui/reload.ts`). Confirmations survive the reload (`PageNotice`).
  - Forms whose Server Action is bound in a Server Component pass it directly to `useActionState`, so they also work without JavaScript. Effects leave the page on success.
  - Forms bound in client components wrap the action and keep the transition pending until the page unloads (`untilPageUnload`).
  - Either way the submit button stays disabled while the next page loads. A test clicking every millisecond lands 0 extra submissions.
  - Redirect targets must be same-origin paths (`sameOriginPath`).
- **Graph overview cost.** The overview of a large analysis takes about 4 s under RLS (per-row visibility through the project chain). This cost already existed; migration `20261024000002` keeps it from doubling.
- **Structure analysis from the project page:** `getSourceProvider()` has returned "unavailable" since commit `7332ef0`. Analysis runs during ZIP upload and GitHub import, not from the project page's button, which therefore does not appear.
- **Not built:**
  - email delivery;
  - per-department admin scope (needs a decision);
  - account-wide suspension (suspension is per organization);
  - ownership transfer;
  - creating a separate receiving task on handoff (the same task moves).

## 9. Migrations (local only, not applied to any hosted database)
| Migration | Content |
| --- | --- |
| `20261022000001_members_invitations.sql` | co-member profiles, invitations, role change, removal, audit trail |
| `20261023000001_workforce_directory.sql` | directory, skills, linking on join (with backfill of existing members), CSV import, profile functions |
| `20261024000001_task_assignment_workflow.sql` | collaborating teams, task fields and statuses, required skills, dependencies, events, comments, handoffs, notifications, assignment mode, workload and candidates |
| `20261024000002_project_collaborator_policy_order.sql` | evaluation-order fix for the collaborating-team policy (performance) |
| `20261025000001_client_privilege_hygiene.sql` | revokes Supabase's default client grants on `profiles` and EXECUTE on the auth trigger functions; revokes only |
| `20261026000001_member_suspension_and_onboarding.sql` | membership status and suspension (active-only membership helpers), invitation notifications and expiry, departments/teams CSV import |
| `20261027000001_sdlc_qa_defects_mentions.sql` | `IN_QA` status and QA policy, defects, links, mentions, deadline notifications, declining, unassignable notices, planning activity, requirement completion rule |

- All seven are additive. No table, column or row is dropped.
- Status constraints are replaced by supersets.
- `add_task_comment` was recreated with an optional `p_mentions` argument; the old call shape still works.
- New columns default to today's behaviour: `status = 'ACTIVE'`, `qa_required = false`.
- No new environment variables.
- Each migration's header describes how to roll it back.

## 10. Tests
- **Unit** (`node:test`, 168 tests in 13 files), including:
  - `src/lib/authz/permissions.test.ts` (with suspension);
  - `src/lib/tasks/workflow.test.ts` (with QA, defects and the QA policy);
  - `src/lib/workforce/csv.test.ts`, `src/lib/workforce/structure-csv.test.ts`, `src/lib/workforce/assignment.test.ts`;
  - `src/lib/members/filter.test.ts`, `src/lib/navigation.test.ts`.
- **Database** (rolled-back fixtures, no global counts): all 18 suites in `supabase/tests`. New in this round:
  - `member_suspension_onboarding_rls.sql`: suspension everywhere, invitation notifications and expiry, structure import;
  - `sdlc_qa_rls.sql`: QA, defects, completion rule, mentions, links, decline, unassignable, deadlines;
  - `privilege_grants_rls.sql`: catalog-wide grant and SECURITY DEFINER hygiene.
  - `repository_structure_rls.sql` runs on an isolated schema copy only, because it writes a temporary Vault key.
- **Browser and HTTP** (scratch harnesses, not in the repository): page access per role and tenant; the RBAC end-to-end flow; the engineering flow; member search and status; organization switching with different roles; suspension; templates; navigation and duplicate-submission checks; existing ingestion, graph and GitHub regressions.
  - The engineering flow covers: QA policy, work, link, mention, review, QA, defect, fix, pass, requirement completion, decline, AUTO queue, departments CSV, suspension.

## 11. Manual verification checklist (local)
1. Start the database (`npm run db:start`) and the app (`npm run dev`, or `npm run build && npm run start`).
2. Sign in as an owner (your own account). Open the organization's **Overview**, then **Members**: invite an admin and an employee, and copy each one-time link.
3. In a private window, sign up with the invited admin email and open the link. You land in the organization as Admin. The owner sees "joined as admin" in Notifications.
4. As the admin, open **Workforce → Import**:
   1. Import a departments CSV, then a teams CSV (templates on the page). Preview, then confirm.
   2. Import the employee CSV.
5. As the owner, invite the employee and let them accept as in step 3. In a team, open a project, create a requirement and a task, and tick **QA required** in Planning.
6. As the admin, set the required skills and assign the task (recommendation shown). The employee sees it in **My work → Up next** and in Notifications.
7. As the employee: Start work, add a pull-request link, comment while mentioning a teammate, then Submit for review. Try Report blocker with a reason, then Resume.
8. As the admin: **Send to QA**. Hand the task to a QA team if you use one. As a tester (another team member): **Fail QA** or report a defect. As the employee: resolve it and submit again. As the admin: Send to QA. As the tester: **Pass QA**.
9. On the requirement page, as the admin: Mark ready, Start, then Complete. It stays disabled until every task is done.
10. Switch organizations with the sidebar selector. If your account belongs to two organizations with different roles, compare the navigation (Settings only where you are owner or admin).
11. Unauthorized access:
    - As the employee, open `/organizations/<id>/settings`: not found.
    - Change the organization id in a project URL to one you are not in: not found.
    - As the owner, suspend the employee on **Members**. The employee's next page load of that organization shows not found, and their dashboard explains it. Reactivate them.
12. Open a project's repository snapshot and its **Repository Graph**, search a symbol and open a focused view. Then try the same URL with another organization's id: not found.
