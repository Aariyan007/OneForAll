# OneForAll — Manual Working Guide

A step-by-step guide for testing OneForAll yourself in the browser, as a new user. It was written by reading the current
source code, configuration and documentation (2026-10-19). **Nothing in this guide has been marked as passed. You decide
every result.**

How to read it:
- **Labels in bold** are the exact words on screen (buttons, headings, menu items).
- `Code style` is a URL, file, field value or command.
- Every walkthrough step has **Purpose**, **Start**, **Actions**, **Expected**, **Failure signs** and **Recovery**.
- Feature status uses four words:
  - **Working**: implemented and reachable in the UI.
  - **Partial**: implemented with a documented gap.
  - **Blocked**: needs something that is not configured (for example an email provider).
  - **Needs manual discovery**: the source code does not make the exact screen certain.

Safety rules for your own testing:
- Do not run `npm run db:reset` and do not delete Docker volumes. Both destroy your data.
- Do not paste passwords, invitation links, tokens, API keys or session cookies into chat, issues or documents.
- Create test records with a clear prefix, for example **`MT `** (manual test): `MT Checkout`, `MT Payment form`.

---

# PART 1 — Preparation

## 1.1 What OneForAll does
OneForAll is an engineering workspace for one company (an **organization**). Major features:

| Area | What you can do | Status |
| --- | --- | --- |
| Accounts | Sign up, sign in, sign out (Supabase Auth, email and password) | Working |
| Organizations | Create organizations, switch between them, overview and settings pages | Working |
| Structure | Departments → Teams → Projects | Working (create and view; no edit or delete screens) |
| Members | Invite by one-time link, roles (Owner, Admin, Employee), suspend, reactivate, remove, search and filter | Working; **email delivery is not configured** |
| Workforce | Directory of people, skills, availability, workload, CSV import of employees, departments and teams | Working |
| Work | Requirements, tasks, dependencies, due dates, links, comments with @-mentions, handoffs between teams | Working |
| Assignment | Manual, recommendation-first, automatic (owner policy); unassigned-task queue | Working (see 2.6 for one wording mismatch) |
| Workflow | To do → In progress → In review → In QA → Completed, blockers, defects, requirement completion | Working |
| Notifications | In-app only (bell icon, Notifications page) | Working; no email or push |
| Repositories | Record a repository, snapshots of exact commits, ZIP upload, public GitHub import | Working; private GitHub and Jira **not verified** |
| Intelligence | File manifest, structure analysis, interactive Repository Graph | Working |

## 1.2 Prerequisites and starting the app
From `docs/manual-setup-checklist.md`, `package.json` and `supabase/config.toml`:

1. **Install:** Node.js 20 or newer, Docker Desktop (running), and the project dependencies (`npm install`, only once).
2. **Start local Supabase** (database, auth, Studio):

```bash
npm run db:start
```

3. **Check that `.env.local` exists.** It must contain values for these names; never show the values to anyone:
   `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `NEXT_PUBLIC_SITE_URL`, `STRUCTURE_PERSIST_KEY`,
   `INTEGRATION_ENCRYPTION_KEY`. Your file already has all five names. Do not edit it for this guide.
4. **Start the app** (development mode):

```bash
npm run dev
```

   If a page that should exist shows **This page isn’t available** in development, stop the server and start it with a clean
   cache:

```bash
npm run dev:clean
```

   Alternative (production mode, slower to start, closer to real use):

```bash
npm run build
```

```bash
npm run start
```

## 1.3 Confirming the services are up
| Check | How | Expected |
| --- | --- | --- |
| Docker | Docker Desktop shows the `supabase_*` containers running | Containers are green / running |
| Supabase stack | Run `npx supabase status` | It lists the API URL, Studio URL and other services. It also prints keys: **do not share that output.** |
| App (frontend and backend together) | Open `http://localhost:3000` | You are sent to **Sign in to OneForAll** (or to the dashboard if already signed in) |

The frontend and backend are one Next.js application. There is no separate API server.

## 1.4 Local URLs (from `supabase/config.toml` and `.env.local`)
| Service | URL |
| --- | --- |
| OneForAll app | `http://localhost:3000` (`NEXT_PUBLIC_SITE_URL`, Supabase `site_url`) |
| Supabase API | `http://127.0.0.1:54321` |
| Supabase Studio (database browser) | `http://127.0.0.1:54323` |
| Local mail catcher (only receives Supabase Auth emails; the app sends none) | `http://127.0.0.1:54324` |
| PostgreSQL (for tools, not the browser) | `127.0.0.1:54322` |

Sign-up email confirmation is **off** locally (`enable_confirmations = false`). A new account can sign in immediately.

## 1.5 Signing in and finding your organization and role
1. Open `http://localhost:3000/login`.
2. Enter **Email** and **Password**, press **Sign in**.
3. You land on the **Dashboard** ("Welcome back, …"). It shows:
   - **Organizations**, **Administered** and **Member only** counts;
   - **Your organizations**, one card per organization;
   - **Pending invitations**, if any are addressed to your email;
   - **Suspended access**, if you are suspended somewhere.
4. Open an organization card. The **Overview** page shows a badge **You: Owner**, **You: Admin** or **You: Employee**. That is
   your role **in that organization only**.
5. The sidebar's organization selector (top left) shows your role under each organization name.

## 1.6 If sign-in fails
| Symptom | Safe next step |
| --- | --- |
| "Invalid login credentials" or similar | Re-type the password; check Caps Lock. Passwords have 8–72 characters. |
| Forgotten password | **No password-reset page exists in the app.** For testing, create a new account with **Create account** instead. Resetting an existing password through Supabase Studio is possible but changes data, and the app has no screen to set a new password from a recovery link: **Needs manual discovery**, and only if you decide to. |
| `/login?error=auth_callback_failed` | An old or used auth link. Sign in normally with email and password. |
| Page keeps loading or shows a connection error | Check Docker and `npx supabase status`; restart the app. See Part 5. |
| You see **This page isn’t available** after sign-in | You are not (or no longer) an active member of that organization, or the dev cache is stale (`npm run dev:clean`). |

## 1.7 Existing accounts and organizations (read-only inspection, 2026-10-19)
No names of people, emails or passwords are listed here.

- **3 accounts** exist.
  - 2 accounts are members of organizations; one of them owns two organizations.
  - 1 account belongs to no organization: useful later for isolation checks.
- **3 organizations**, each with exactly one member, its **Owner**:

| Organization | Departments | Projects | Completed snapshots | Completed analyses |
| --- | --- | --- | --- | --- |
| `Wipro` | 1 | 2 | 1 | 1 |
| `WIPRO` | 1 | 1 | 0 | 0 |
| `tcs` | 1 | 2 | 2 | 2 |

- There are no Admins, Employees, invitations or notifications yet. To test other roles you will create **new accounts**
  (Part 3, step C4).
- Repository graphs can be opened in `tcs` and `Wipro` (completed analyses exist). **Use those instead of importing again.**

---

# PART 2 — Understanding the application

## 2.1 The hierarchy (as implemented)
```
Organization
└── Department                    (Departments page)
    └── Team                      (Teams page of a department)
        └── Project               (Projects page of a team; a project belongs to exactly ONE team)
            ├── Requirements → Tasks          (planning and work)
            ├── Repository (one per project)  (Repository card on the project page)
            │   └── Snapshot (one exact commit)
            │       └── Files (the recorded manifest)
            │           └── Structure Analysis (symbols and relationships)
            │               └── Repository Graph (interactive view)
            └── Teams on this project         (the owning team + collaborating teams)
```

URL pattern (every level is in the address bar):

```
/organizations/<org>/departments/<dept>/teams/<team>/projects/<project>
    /requirements/<requirement>/tasks/<task>
    /repository/snapshots/<snapshot>/graph
    /integrations
```

Rules worth knowing:
- **Role** lives on the organization membership: Owner, Admin or Employee (the database calls Employee `MEMBER`). One account can
  have different roles in different organizations.
- **Who sees a project:** Owners and Admins of the organization see every project. An Employee sees a project only if they are a
  member of the project's team or of a **collaborating team** of that project.
- **Team membership** has no separate screen. A person joins a team through their **home team** in the **Workforce** directory
  (set by an Owner/Admin with **Edit entry and skills** → **Home department / team**, or by the CSV `team` column).
  - When the person is already a member, the home team is applied at once. Otherwise it is applied when they join.
  - Changing the home team adds the new team; it does **not** remove the old one. There is no screen to remove someone from a
    team. **Partial.**
- **Workforce profile** is one directory entry per person per organization, matched by email. It holds full name, employee
  code, job title, home department/team, availability and skills.
- **Tasks** belong to a requirement. A task has at most one **assignee**, a **responsible team** (the project's team, or another
  team after a handoff), required skills, an estimate, a due date, a **QA required** flag, dependencies, links, comments, defects
  and an activity log.

## 2.2 Navigation (sidebar)
| Section | Item | Goes to | Notes |
| --- | --- | --- | --- |
| General | **Dashboard** | `/dashboard` | |
| General | **My work** | `/my-work` | Your tasks across all organizations |
| General | **Notifications** | `/notifications` | Also the bell in the top bar, with the unread count |
| General | **Organizations** | `/organizations/new` | List of your organizations and **Create an organization** |
| Workspace | **Overview** | `/organizations/<org>/overview` | Needs an organization open |
| Workspace | **Members** | `…/members` | |
| Workspace | **Workforce** | `…/workforce` | **Import** under it |
| Workspace | **Departments** | `…/departments` | |
| Workspace | **Teams** | `…/departments/<dept>/teams` | Needs a department open |
| Workspace | **Projects** | `…/teams/<team>/projects` | Needs a team open |
| Workspace | **Settings** | `…/settings` | Owners and Admins only (hidden for Employees) |
| Engineering | **Project overview**, **Requirements**, **Repository**, **Engineering Intelligence** | parts of the open project | Needs a project open |

Other controls:
- **Search or jump to…** (top bar, `Ctrl K`) opens the command palette.
- The account menu (top right, your initials) has **Sign out**.
- Greyed-out sidebar items say what to open first, for example "Open a team".

## 2.3 Roles at a glance (from `docs/rbac-workforce.md`; the database enforces them)
| Action | Owner | Admin | Employee |
| --- | --- | --- | --- |
| Create departments, teams, projects, requirements, tasks; import CSVs | ✓ | ✓ | – |
| Invite | Admins and Employees | Employees only | – |
| Change roles | ✓ (never an owner, never yourself) | – | – |
| Suspend / reactivate | Admins and Employees | Employees | – |
| Assignment policy | edit | read only | – |
| Assign tasks, review, cancel, reopen, mark QA required | ✓ | ✓ | – |
| Work an assigned task (start, block, resume, submit, stop, decline before starting) | ✓ | ✓ | ✓ (own tasks) |
| Pass or fail QA, report defects | ✓ | ✓ | if in the responsible team and **not** the assignee |
| Resolve a defect, add links | ✓ | ✓ | if assignee |
| Comment and @-mention | ✓ | ✓ | ✓ (projects they can see) |
| Connect repository, create snapshot, upload ZIP, GitHub import, integrations | ✓ | ✓ | read only |

## 2.4 Task lifecycle (as implemented)
```
To do ──Start work──> In progress ──Submit for review──> In review ──Send to QA──> In QA ──Pass QA──> Completed
  │                     │  ▲   │                            │  │                   │
  │      Report blocker │  │   └─Stop work (back to To do)  │  └─Approve (only if  └─Fail QA / defect ──> In progress
  │                     ▼  │ Resume                         │    QA NOT required) ──> Completed
  │                   Blocked                               └─Request changes ──> In progress
  └─Cancel task (reason) ──> Cancelled ──Restore──> To do          Completed ──Reopen / defect──> In progress
```
- Reasons are required for **Report blocker**, **Cancel task**, **Request changes** and **Fail QA**.
- A task cannot start without an assignee.
- A task cannot start, go to review or QA, or be completed while a task it depends on is unfinished.
- With **QA required** ticked, a task can only be completed by **Pass QA**.
- Open defects block **Send to QA** and completion.
- **Requirement status:** Draft → **Mark ready** → **Start** → **Complete** (or **Cancel**). **Complete** works only when every task
  of the requirement is Completed or Cancelled.

## 2.5 What is not available (do not search for it)
- **Blocked:**
  - Email delivery of any kind (invitations are copied links; notifications are in-app only).
- **Not built:**
  - Password reset page;
  - ownership transfer, deleting an organization, account-wide suspension;
  - edit or delete screens for departments, teams, projects, requirements and tasks;
  - per-department or per-team Admin scope (Admins are organization-wide);
  - a separate receiving task on handoff (the same task moves between teams).
- **The project page's own "Analyze Structure" button does not appear:** the default source provider is unavailable. Analysis
  runs automatically during ZIP upload and GitHub import instead.
- **Not verified:**
  - private GitHub repositories with a token;
  - Jira Cloud connect and sync.
  - Both are implemented, but they need real credentials.

## 2.6 One known wording mismatch
On the assignment policy, **Automatic** says tasks are assigned "when created or on request". In the current code, tasks are
**not** assigned at creation. Automatic assignment happens only when an Owner/Admin presses **Assign automatically** on a task or
**Assign queue automatically** on the Overview. Record this as a finding if you test it.

---

# PART 3 — Manual walkthrough

### Accounts you will need
| Name in this guide | How you get it | Used in |
| --- | --- | --- |
| **Owner** | Your existing account that owns an organization | everything |
| **Admin** | New account, invited as Admin by the Owner | C, D, E, F, G |
| **Employee** | New account, invited as Employee | C, E, F, G |
| **QA** | New account, invited as Employee and put in the same team as the Employee | G, I |
| **Outsider** | Your existing account with no organization (or any account outside the test organization) | C (isolation) |

Use **separate browsers or separate browser profiles** for different accounts, for example Chrome profile 1, Chrome profile 2,
Edge and Firefox. Private windows of the same browser share one session, so they cannot hold two accounts at once. Switching the
UI never changes who you are: only signing in as a different account does.

Choose one organization for all tests: the **test organization**. You can use one of your existing ones, or create
`MT Test Org` in step A5 to keep test records separate.

---

## A. First login and organization access

**A1. Sign in**
- **Purpose:** authentication works and lands on the dashboard.
- **Start:** `http://localhost:3000`.
- **Actions:** enter **Email** and **Password** of the Owner account → **Sign in**.
- **Expected:** **Dashboard** with "Welcome back, <name>" and **Your organizations**.
- **Failure signs:** error under the form; endless **Signing in…**; blank page.
- **Recovery:** 1.6 and Part 5.1.

**A2. Read your role**
- **Purpose:** the role shown matches the membership.
- **Start:** Dashboard → open an organization card.
- **Actions:** look at the badge in the page header.
- **Expected:** **You: Owner** on the **Overview** page. The sidebar selector lists the same role.
- **Failure signs:** no badge, wrong role, or **This page isn’t available**.
- **Recovery:** go back to **Dashboard**; open another organization; note the result.

**A3. Switch organization**
- **Purpose:** switching changes all data on screen.
- **Start:** any organization page.
- **Actions:** click the organization selector (top of the sidebar) → choose another organization.
- **Expected:** the URL changes to `/organizations/<other id>/overview`. The name, counts and lists are those of the other
  organization, with nothing left over from the previous one.
- **Failure signs:** old organization's data still visible; error page.
- **Recovery:** reload the page (`F5`); report it if old data persists.

**A4. Dashboard, Organizations and Settings**
- **Purpose:** the main pages open for an Owner.
- **Start:** sidebar.
- **Actions:**
  1. **Dashboard**.
  2. **Organizations** (list plus **Create an organization**).
  3. In an organization: **Settings**.
- **Expected:** Settings shows **General** (**Organization name**, **Save name**), **Assignment policy** with **Save policy**
  (enabled for Owners), **People and structure** links, and **Not available** (ownership transfer and deletion).
- **Failure signs:** Settings missing for an Owner; **Save policy** missing.
- **Recovery:** check the role badge (A2).

**A5. (Optional) Create a test organization**
- **Purpose:** organization creation works; gives you a clean test space.
- **Start:** **Organizations** → **Create an organization**.
- **Actions:** **Organization name** `MT Test Org` → **Create organization**.
- **Expected:** you land on the new organization's **Departments** page with a green **Created MT Test Org** message (slug and
  your role: Owner). The organization appears in the sidebar selector.
- **Failure signs:** button stays on **Creating…**; error message.
- **Recovery:** do **not** press again. Open **Organizations** and check whether it was created before retrying.

**A6. Role check for the Owner**
- **Purpose:** pages and actions match the role.
- **Start:** test organization **Overview**.
- **Actions:** confirm you see **Assignment queue**, **Blocked and overdue**, **In review and QA**, **Workload**, **Settings**.
- **Expected:** all visible for an Owner. (You will repeat this as Admin and Employee in C7.)

---

## B. Organization setup

**B1. Overview and settings**
- **Purpose:** know the two organization-level pages.
- **Start:** **Overview**.
- **Actions:** read the metric cards (**Open tasks**, **Unassigned**, **Blocked**, **Overdue**), **Structure** (departments,
  teams, projects you can see, active members) and **Pending handoffs**. Then **Settings** → rename is optional: if you try it,
  change the name to `MT Test Org (renamed)` and **Save name**, then change it back.
- **Expected:** after **Save name** the page reloads showing the new name and a green "Organization renamed." message.
- **Failure signs:** name unchanged after reload.
- **Recovery:** read the error under the field; Admins and Owners only.

**B2. Departments**
- **Purpose:** create and see a department.
- **Start:** sidebar **Departments**.
- **Actions:** **New department** (or **Create department** on an empty page) → **Name** `MT Engineering`, **Description**
  optional → **Create department**.
- **Expected:** back on **Departments**, `MT Engineering` is listed with its description.
- **Failure signs:** "already exists" error (names are unique per organization, case-insensitive); button stuck on
  **Creating…**.
- **Recovery:** if the name exists, use the existing department instead of a new one. If stuck, reload the Departments page
  and check the list before retrying, so you don't create a duplicate.
- Also create `MT Quality` the same way: you will need it for the QA team. Or create it later by CSV in D4.

**B3. Teams**
- **Purpose:** a team belongs to one department.
- **Start:** **Departments** → open `MT Engineering`.
- **Actions:** **New team** → **Name** `MT Web` → **Create team**. Open `MT Quality` → **New team** `MT QA`.
- **Expected:** each team is listed under its own department only. The URL contains that department's id.
- **Failure signs:** the team appears under the wrong department.
- **Recovery:** do not create it again; note the URL and report it.

**B4. Team membership (how it works today)**
- **Purpose:** understand that membership comes from the Workforce directory.
- **Start:** the department or team page shows **Department members** / **Members** counts.
- **Actions:** none yet. You add people to `MT Web` in D2 or D5 (home team).
- **Expected:** counts are 0 until people are linked. There are no add/remove-member buttons here. **Partial**, by design of
  the current UI.

**B5. Projects**
- **Purpose:** a project belongs to one team.
- **Start:** `MT Web` team page.
- **Actions:** **New project** → **Project name** `MT Shop`, **Description** optional, **Project type** **Greenfield** or
  **Brownfield** → **Create project**.
- **Expected:** `MT Shop` is listed on the team's **Projects** page. Open it to see **Project overview** with the
  **Requirements** card, the **Repository** card ("No repository connected") and **Teams on this project**.
- **Failure signs:** error; project not listed.
- **Recovery:** reload **Projects** before retrying.

**B6. Verify parent–child relationships**
- **Purpose:** the hierarchy is enforced.
- **Start:** the `MT Shop` project page.
- **Actions:** read the breadcrumb and the URL: `/organizations/<org>/departments/<MT Engineering>/teams/<MT Web>/projects/<MT Shop>`.
  Then, in the address bar, replace the team id with the id of `MT QA` (copy it from the `MT QA` page URL) and press Enter.
- **Expected:** **This page isn’t available**: the project is not found under another team.
- **Failure signs:** the project opens under the wrong team.
- **Recovery:** go back (`Alt ←`).

---

## C. Members, invitations and permissions

**C1. Member directory**
- **Start:** sidebar **Members**.
- **Expected:**
  - **Invite someone** (Owners and Admins);
  - **People (n)** with each person's name, email, job title, team, **Joined** date and role;
  - **Pending invitations (n)**;
  - **Membership activity** (Owners and Admins).

**C2. Search and filter**
- **Actions:** type part of your name in **Search name, email, job title, department or team** → choose **All roles** /
  **Owner** / **Admin** / **Employee** and **Any status** / **Active** / **Suspended** → **Filter**.
- **Expected:** heading becomes **People (x of n)**; **Clear** appears; the URL has `?q=…&role=…&status=…`. With no match:
  **No matching members**.
- **Failure signs:** filter ignored; an error page.
- **Recovery:** **Clear**.

**C3. Create invitations (Owner)**
- **Purpose:** the supported invitation process (no email is sent).
- **Start:** **Members** → **Invite someone**.
- **Actions:** **Email** `mt.admin@example.com`, **Role** **Admin** → **Create invitation**. Then repeat with
  `mt.employee@example.com` (**Employee**) and `mt.qa@example.com` (**Employee**). Use addresses you control, or obviously
  fake test addresses as shown; no mail is delivered either way.
- **Expected:** a green message with a read-only **Invitation link** field and **Copy link** / **Done**. The text says no email
  provider is configured, the link works once, for that email only, and expires in 7 days. After **Done**, the invitation is
  listed under **Pending invitations** with role, created and expiry time.
- **Failure signs:** error about an existing pending invitation (one per address); no link.
- **Recovery:** use the pending invitation's existing state; revoke and re-create if you lost the link (C6).
- **Important:**
  - The link is shown **once** and is a secret: paste it only into the address bar of the browser where the invitee will sign
    up.
  - An Admin can invite **Employees only**. Nobody can invite an Owner.

**C4. Accept an invitation (new account)**
- **Purpose:** onboarding creates the membership with the invited role.
- **Start:** a **different browser or profile**.
- **Actions:**
  1. Paste the Admin's invitation link. The page **Join an organization** asks you to sign in. Choose **Create account**.
  2. Fill **Name** `MT Admin`, **Work email** `mt.admin@example.com` (exactly the invited address), **Password** (your choice,
     at least 8 characters; keep it in your own password manager) → **Create account**.
  3. Open the **same invitation link again**. It shows the organization and role → **Accept and join <organization>**.
- **Expected:** you land in the organization. The Overview badge says **You: Admin**. In the Owner's browser, **Members** lists
  `MT Admin` as **Admin**, and **Notifications** has "… joined as admin".
- **Failure signs:**
  - **Different account**: you are signed in with another email;
  - **Invitation not available**: used, revoked or expired;
  - **No invitation found**: the link was cut off before the `#…` part.
- **Recovery:** sign out and sign in with the invited email; ask the Owner for a new invitation; paste the full link.
- Repeat for `MT Employee` and `MT QA` in their own browsers or profiles.

**C5. Change a role (Owner)**
- **Start:** **Members**, in the Owner's browser.
- **Actions:** in `MT QA`'s row open the role dropdown → **Admin** → confirm. Then set it back to **Employee**.
- **Expected:** after each change the page reloads with the new role, and **Membership activity** logs "changed the role of …".
  You cannot change an Owner's role or your own.
- **Failure signs:** dropdown missing for the Owner; role unchanged after reload.

**C6. Revoke and expiry**
- **Purpose:** invitations can be withdrawn; expired ones close.
- **Actions:** create an invitation for `mt.unused@example.com` → **Done** → in **Pending invitations** press **Revoke** →
  confirm.
- **Expected:** it moves to **Recent closed invitations** as revoked; opening its link says it is not available.
- **Expiry:** after 7 days a pending invitation becomes **Expired** the next time an Owner/Admin opens **Members** or **Overview**,
  and the inviter gets a notification. You cannot speed this up from the UI; mark it **Not tested** unless you wait.

**C7. Permissions per role**
- **Purpose:** each role sees only what it may.
- **Actions:** in each account's browser, open the test organization:

| Check | Owner | Admin (`MT Admin`) | Employee (`MT Employee`) |
| --- | --- | --- | --- |
| **Overview** shows **Assignment queue** and **Workload** | yes | yes | no; shows **Your open tasks here** |
| Sidebar shows **Settings** | yes | yes | no |
| Open `…/settings` by URL | page opens | opens; policy says **Only an owner can change the assignment policy** | **This page isn’t available** |
| **Members** shows **Invite someone** | yes (Admin + Employee roles) | yes (Employee only) | no |
| **Workforce** shows the full **Directory** | yes | yes | only **Your profile** |
| **New department** / **New team** / **New project** buttons | yes | yes | no |

**C8. Suspend and reactivate**
- **Start:** **Members** as Owner (or as Admin for an Employee).
- **Actions:** in `MT Employee`'s row press **Suspend** → confirm. In the Employee's browser, reload the organization's
  **Overview**, then open **Dashboard**. Back as Owner: filter **Suspended**, press **Reactivate** → confirm.
- **Expected:**
  - The Employee's row shows a **Suspended** badge; their open tasks in this organization are unassigned.
  - The Employee gets **This page isn’t available** for that organization, and their **Dashboard** shows **Suspended access**
    with the organization's name.
  - After **Reactivate**, access returns with the same role, and the Employee gets "Your access was restored".
- **Failure signs:** the suspended person can still open organization pages after a reload.
- **Recovery:** reactivate them; report it.
- Owners cannot be suspended, and nobody can suspend themselves.

**C9. Organization isolation (safe check)**
- **Purpose:** an outsider cannot reach another organization's pages, even with the exact URL.
- **Start:** as Owner, copy the URL of the `MT Shop` project page.
- **Actions:** in the **Outsider** account's browser (an account that is not a member of the test organization), paste the URL.
  Also try `/organizations/<test org id>/members` and `/organizations/<test org id>/settings`.
- **Expected:** **This page isn’t available** every time. No names, counts or titles of the test organization appear.
- **Failure signs:** any data of the test organization is shown.
- **Recovery:** none needed; you only viewed. Report it.
- This uses only your own accounts and test records. Do not try other people's organizations.

---

## D. Workforce directory and CSV import

**D1. Workforce page**
- **Start:** sidebar **Workforce**.
- **Expected:**
  - **Your profile**: **Your availability** (Available / Busy / Unavailable) and **Your skills**;
  - **Directory (n)** for Owners and Admins, with each person's availability, skills, active, blocked and overdue counts, and
    hours, plus **Edit entry and skills**;
  - **Skill vocabulary (n)**;
  - **Assignment policy**.

**D2. Set a home team and skills (Admin)**
- **Purpose:** this is how people join a team today.
- **Actions:**
  1. If skill `React` is missing, type it in **Skill vocabulary** (placeholder "e.g. React, PostgreSQL, API Testing") → **Add skill**.
  2. In `MT Employee`'s directory row → **Edit entry and skills** → **Home department / team**: choose `MT Web` under
     `MT Engineering` → **Save entry**.
  3. Tick `React` for that person → **Save skills**.
  4. Do the same for `MT QA`: home team `MT Web`, a skill such as `API Testing`. Both must be in `MT Web` for the QA flow in G.
- **Expected:** after reload the row shows the team and skills. The `MT Web` team page shows the members, and `MT Employee` can
  now see project `MT Shop`.
- **Failure signs:** the Employee still cannot open `MT Shop`.
- **Recovery:** reload the Employee's page; confirm the team was saved.

**D3. Download templates**
- **Start:** **Workforce** → **Import** (`…/workforce/import`).
- **Actions:**
  - **Download template**: `employees-template.csv`;
  - in **Departments and teams**: **Departments template** (`departments-template.csv`) and **Teams template**
    (`teams-template.csv`).
- **Expected:** three CSV files with fictional example rows.

**D4. Import departments and teams (Admin)**
- **Purpose:** preview and confirm without duplicates.
- **Actions:**
  1. Create a file `mt-departments.csv`:

```csv
name,description
MT Platform,Shared services for manual testing
```

  2. In **Departments and teams** choose **File contains** **Departments** → choose the file → **Preview**.
  3. Read the result table, then **Confirm import** → confirm.
  4. Then a teams file `mt-teams.csv`:

```csv
department,name,description
MT Platform,MT API,APIs for manual testing
```

  5. **File contains** **Teams** → **Preview** → **Confirm import**.
- **Expected:**
  - The preview says **Preview of mt-departments.csv: 1 new, 0 updated, 0 unchanged, 0 with errors**. Nothing is created yet.
  - After confirming: **Imported** and **Open departments**.
  - Re-importing the same file shows **unchanged** (no duplicate).
  - A team whose department does not exist is an **error** row: "unknown department … (import departments first)".
- **Failure signs:** department created at preview time; duplicates after a second import.
- **Recovery:** fix the file and preview again. Errors are skipped rows, never partial records.

**D5. Import employees (Admin)**
- **Actions:** create `mt-employees.csv` (use the template's header):

```csv
full_name,email,employee_code,department,team,job_title,skills,availability
MT Future Hire,mt.future@example.com,MT-001,MT Engineering,MT Web,Frontend Engineer,React;TypeScript,AVAILABLE
MT Employee,mt.employee@example.com,MT-002,MT Engineering,MT Web,Frontend Engineer,React,AVAILABLE
```

  In the first upload form on the import page (below **Rules**, labelled **CSV file (UTF-8, at most 512 KiB and 2,000 rows)**)
  → choose the file → **Preview** → **Confirm import** → confirm.
- **Expected:**
  - The preview counts **new / updated / unchanged / with errors**: `mt.future` new, `mt.employee` updated or unchanged.
  - After confirming, **Open the directory** shows `MT Future Hire` **without an account**. The import never creates accounts,
    invitations or roles.
  - If `MT Future Hire` is later invited and joins with that email, their entry and home team are applied.
- **Failure signs:** an account or membership created by the import.
- **Recovery:** none needed; report it.

**D6. Validation errors and safety**
- **Actions:** preview a file with a `role` column, a bad email (`not-an-email`) and the same email twice.
- **Expected:**
  - A `role`, `password`, `token`, `user_id` or `organization_id` column rejects the **whole file** with an explanation (roles
    cannot be set from CSV).
  - Bad and duplicate emails are **error** rows; the other rows can still be confirmed.
  - Files over 512 KiB or 2,000 rows are refused.
- **Recovery:** fix the file and preview again. Never create people by hand to get around an error.

---

## E. Requirements and tasks

**E1. Create a requirement (Owner/Admin)**
- **Start:** `MT Shop` → **Requirements** card or sidebar **Requirements**.
- **Actions:** **New requirement** → **Title** `MT Checkout`, **Description** optional, **Priority** → **Create requirement**.
- **Expected:** it appears in the list with status **Draft**. Open it: **Requirement status** card with **Mark ready**, and
  **Details**.

**E2. Create tasks**
- **Actions:** in `MT Checkout` → **New task** → **Title** `MT Payment form` → **Create task**. Create `MT Coupon field` too.
- **Expected:** both are listed in the requirement with status **To do**.

**E3. Task page tour**
- **Start:** open `MT Payment form`.
- **Expected sections:**
  - **What to do**: description, **Acceptance criteria**, **Required skills**;
  - **Status**: actions you may take, with reasons when a step is unavailable;
  - **Links**, **Dependencies**, **Handoffs**, **Comments and activity** (with **Activity log**);
  - **Details**: assignee, responsible team, estimate, due date, QA;
  - for Owners/Admins: **Assignment** and **Planning**.

**E4. Planning, due date and dependencies (Owner/Admin)**
- **Actions:**
  1. In **Planning** fill **Acceptance criteria** ("Card number accepts digits only"), **Estimate (hours)** `4`, **Due date**
     (tomorrow) → **Save planning**.
  2. In **Dependencies** choose `MT Coupon field` in **Add a dependency** → **Add**.
- **Expected:**
  - After reload the details show the estimate and due date; the activity log shows "changed the due date".
  - The dependency is listed. **Start work** is unavailable with "Waiting for 1 unfinished dependency." until `MT Coupon field`
    is completed or cancelled.
- **Recovery:** **Remove** the dependency if you want to continue now.

**E5. Requirement completion rule**
- **Actions:** on `MT Checkout`: **Mark ready** → **Start**.
- **Expected:** **Complete** is disabled while any task is open, with a message counting the open tasks. It becomes available
  only when every task is Completed or Cancelled. You will finish this in G9.

| Action | Who |
| --- | --- |
| Create requirement/task, planning, dependencies, requirement status | Owner, Admin |
| Start, block, resume, submit, stop, decline | the assignee |
| Approve, Send to QA, Request changes, Cancel, Reopen | Owner, Admin |
| Pass or fail QA, report defect | Owner, Admin, or a tester (responsible team, not the assignee) |

---

## F. Workforce profiles and task assignment

**F1. Check skills and availability**
- **Start:** **Workforce** (Owner/Admin).
- **Expected:** `MT Employee` has skill `React` and **Available**. The Employee can change their own availability in **Your
  profile**.

**F2. Required skills and recommendation (Owner/Admin)**
- **Start:** `MT Payment form` → **Planning** → **Required skills**.
- **Actions:** tick `React` → **Save required skills**.
- **Expected:** after reload the **Assignment** card lists **Eligible people, best match first**, each with reasons (skills
  covered, availability, load). People who cannot see the project, or who are **Unavailable**, are not eligible and are listed
  with the reason. A recommendation is **only a suggestion**: nothing is assigned until you press a button.

**F3. Assign manually**
- **Actions:** in **Assignment** choose `MT Employee` → **Assign** (in **Recommendation first** mode, **Confirm
  recommendation** assigns the preselected person).
- **Expected:** after reload **Assignee** shows the Employee and the status stays **To do** (assigned is not started). The
  Employee gets "Assigned to you" in **Notifications** and sees the task in **My work → Up next**, or **Upcoming** while a
  dependency is open.
- **Failure signs:** "The assignment changed in the meantime": someone else changed it; reload and try again.

**F4. Employee view, decline and blocker**
- **Start:** the Employee's browser → **My work**.
- **Actions:**
  1. On a task assigned to you that you have **not** started, press **Decline assignment** → reason → **Decline**.
  2. Later, on a started task, press **Report blocker** → describe it → confirm.
- **Expected:**
  - **Decline:** the task is unassigned and appears in the Owner's **Overview → Assignment queue**. The person who assigned it
    and the managers are notified.
  - **Report blocker:** status **Blocked**, with the reason shown in the activity log. Managers are notified. **Resume** returns
    it to **In progress**.
- **Failure signs:** **Decline assignment** visible on a started task (it should not be).

**F5. Unassigned queue and automatic mode (Owner)**
- **Actions:** **Settings** → **Assignment policy** → **Automatic** → **Save policy** → confirm. Open **Overview** → **Assignment
  queue** → **Assign queue automatically** → confirm.
- **Expected:**
  - A green message "Assigned x of y tasks automatically", listing tasks that were not assigned and why.
  - Tasks **without required skills are never auto-assigned**, because nothing shows who is qualified. When nobody is eligible,
    the other managers get "Nobody eligible".
  - Each assignment is logged with mode **AUTO** and its reasons.
- **Safeguards:**
  - Only an Owner can enable it.
  - At most 25 tasks per run.
  - People are skipped if unavailable or if the task would push them over 40 hours.
  - Assignments use compare-and-set, so a concurrent change wins.
- **Afterwards:** set the policy back to **Manual** if you prefer.

---

## G. Full software development workflow
Accounts: **Owner or Admin** (manager), **Employee** (developer, assignee), **QA** (tester: `MT QA` must be in team `MT Web`, D2,
and must not be the assignee). Each step names the account; sign in to each in its own browser.

| # | Account | Screen and action | Expected |
| --- | --- | --- | --- |
| G1 | Manager | `MT Payment form` → **Planning**: tick **QA required** → **Save planning** | **Details** shows **QA: Required**; activity log "changed whether QA is required" |
| G2 | Manager | **Assignment**: assign `MT Employee` (if not already) | Employee notified |
| G3 | Employee | **Status** → **Start work** (cancel or complete the dependency first, or remove it) | **In progress** |
| G4 | Employee | **Links**: **Link (https)** `https://github.com/example/shop/pull/1`, **Label** `PR #1` → **Add link** | Link listed; opens in a new tab |
| G5 | Employee | **Comments and activity**: write a comment, open **Mention people (they are notified)**, tick `MT QA` → **Comment** | Comment shown; `MT QA` gets "You were mentioned" |
| G6 | Employee | **Submit for review** | **In review**; managers get "Review requested" |
| G7 | Manager | **Send to QA**. (**Approve** is not offered because QA is required.) | **In QA**; `MT QA` gets "Ready for QA"; the Employee gets "Review approved, now in QA" |
| G8 | QA | **My work → To test** → open the task. **Report a defect**: **Title** `Card number accepts letters`, **Severity** **High**, steps → **Report defect** → confirm | Task back to **In progress**; **Defects (1 open)**; the Employee is notified |
| G9 | Employee | **Defects** → **Mark resolved** → optional note → **Resolve**, then **Submit for review** | Defect **Resolved**; QA notified |
| G10 | Manager | **Send to QA** | **In QA** |
| G11 | QA | **Pass QA** (or **Fail QA** with what failed, to repeat the loop) | **Completed**; the Employee gets "Completed" |
| G12 | Manager | Cancel `MT Coupon field` (**Cancel task**, reason "Out of scope"), then open `MT Checkout` → **Complete** | Requirement **Completed** |
| G13 | any | **Activity log** of `MT Payment form`; **Notifications** of each account | Planning change, assignment, status changes with reasons, link, comment, defect reported and resolved |

Notes:
- **The assignee cannot pass their own QA:** the Employee sees no **Pass QA** button.
- **A QA team instead of a team member:**
  1. On the project page, **Teams on this project** → **Add a team…** `MT QA` → **Add**.
  2. On the task, **Handoffs** → hand it to `MT QA` with a summary.
  3. A member of `MT QA` presses **Accept**. Testing then belongs to `MT QA`.
- **Due dates:** a task due within two days, or overdue, creates a "Due …" or "Overdue" notification for its assignee the next
  time they load a page. There is no background job.

---

## H. Repository integration and intelligence
Use the existing completed analyses in `tcs` or `Wipro` to explore graphs. Do not re-import large repositories.

**H1. Inspect a repository**
- **Start:** a project in `tcs` or `Wipro` → **Repository** card.
- **Expected:** **Provider**, **Status**, **Visibility**, **Default branch**; **Engineering Intelligence** (Repository
  Intelligence) with the latest snapshot and **View Repository Graph** when an analysis is completed.

**H2. Connect a repository (only on your test project)**
- **Start:** `MT Shop` → **Connect repository**.
- **Actions:** **Provider** **GitHub**, **Repository URL** `https://github.com/<owner>/<name>` (a small public repository you
  choose), **Default branch** (for example `main`) → **Connect repository**.
- **Expected:** the project page shows the repository as **Pending** with **Unknown** visibility. Nothing is downloaded yet.
- **Note:** GitLab, Bitbucket and Generic Git can be recorded, but only GitHub can be imported. Other providers use ZIP upload.

**H3. Public GitHub import (optional; uses the shared limit of 60 GitHub requests per hour)**
- **Actions:** **Repository** card → **Import from GitHub** → wait for branches → choose a branch → leave the SHA empty (latest)
  or paste a full SHA → **Resolve commit** → check the commit shown → **Import this commit**. Keep the page open.
- **Expected:**
  - The repository becomes **Connected / Public**.
  - After the import, the project page reloads with an "Imported from GitHub" confirmation (snapshot completed, analysis
    status, links).
  - Importing the same commit again says **Already imported**.
- **Failure signs:** "GitHub rate limit reached" (wait); "The repository archive is larger than the 8 MiB import limit."
- **Recovery:** **Retry import**; use a smaller repository; or ZIP upload (H4).
- **Private repositories:** need a fine-grained token saved under **Project → Integrations → GitHub**. That flow is implemented
  but **not verified**. Do not enter a real token unless you choose to test it.

**H4. ZIP upload**
- **Actions:** **Engineering Intelligence** → **Create snapshot** → **Commit SHA** (full 40 or 64 characters), **Branch** →
  **Create snapshot** → on the snapshot page choose a `.zip` (up to 8 MiB) → **Upload and process**.
- **Expected:**
  - **Upload and process** stays disabled until a valid `.zip` is chosen. Processing happens in the same request; keep the page
    open.
  - The snapshot becomes **Completed**, with recorded files and the excluded counts: archive metadata, generated folders, files
    that may contain credentials, files over 2 MiB.
  - Analysis status is shown separately. The source is labelled **Unverified upload**.
- **Failure:**
  - An invalid archive is rejected with a reason, and the snapshot is unchanged.
  - A failure after processing started marks the snapshot **Failed**; upload again to retry.
  - A snapshot stuck in **Processing** for more than 10 minutes offers **Mark as failed**.

**H5. Snapshots and analysis status**
- **Start:** **Snapshots** list.
- **Expected:**
  - Snapshot status: **Pending** (no source), **Processing**, **Completed** (files sealed; analysis may still differ), or
    **Failed**.
  - Analysis status is separate. The graph needs a **Completed** analysis; otherwise the graph page says the structure is
    unavailable or not completed.

**H6. Repository Graph**
- **Start:** **View Repository Graph** (project) or **Repository graph** (snapshot list).
- **Explore:**
  - **Search symbols by name or qualified name**: results list; **Show it** reveals a result hidden by filters.
  - Filters: symbol kinds, relationship types, one file.
  - **Canvas:** drag to pan; wheel or pinch to zoom; **Zoom in**, **Zoom out**, **Fit graph to view**.
  - **Selecting a node:** **Details** shows its metadata ("Not available" for missing fields) and its **Incoming** and
    **Outgoing** relationships.
  - **Focus on direct neighbours**, **Reset view**.
- **Large analyses** (over 5,000 symbols): overview of **Folders and files**, **Files with the most symbols**, file views,
  **Expand neighbours** and **New view from here**. A view holds at most 400 symbols; **This view is full** explains a refused
  expansion.
- **Expected limits:** only `CONTAINS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS` relationships exist. Call graphs and cross-file
  dependencies are not extracted, and the legend says so.

---

## I. Final user journey (four people)
Prerequisites: Owner (existing account), `MT Admin`, `MT Employee`, `MT QA` accepted (C4); `MT Employee` and `MT QA` both have
home team `MT Web` (D2).

1. **Owner:** **Settings** → **Assignment policy** **Recommendation first** → **Save policy**. Check **Members** shows all four.
2. **Admin:** `MT Shop` → **New requirement** `MT Order history`; **New task** `MT History page`; **Planning**: acceptance
   criteria, estimate `3`, due date, **QA required**; **Required skills** `React`.
3. **Admin:** **Assignment** shows `MT Employee` preselected with reasons → **Confirm recommendation**.
4. **Employee:** **My work → Up next** → **Start work** → **Add link** (pull request URL) → comment mentioning `MT QA` → **Submit
   for review**.
5. **Admin:** **My work → To review** → open → **Send to QA**.
6. **QA:** **My work → To test** → **Report defect** (Medium).
7. **Employee:** **Mark resolved** → **Resolve** → **Submit for review**.
8. **Admin:** **Send to QA**. **QA:** **Pass QA**.
9. **Admin:** requirement `MT Order history` → **Mark ready** → **Start** → **Complete**.
10. **Owner:** **Overview** (counts and recent activity) and the task's **Activity log**; each person's **Notifications**.

- **Blocked:** emailing invitations or notifications (no provider).
- **Not verified:** private repositories and Jira.

---

# PART 4 — Manual checklist
Print this table. Leave "My result" empty until you test. Use: **Pass / Fail / Blocked / Not tested**.

| ☐ | Step | Feature | Account / role | Expected result | My result | Notes and evidence |
| --- | --- | --- | --- | --- | --- | --- |
| ☐ | 1.3 | Services running (Docker, `npx supabase status`, app on :3000) | — | All up | | |
| ☐ | A1 | Sign in | Owner | Dashboard | | |
| ☐ | A2 | Role badge | Owner | You: Owner | | |
| ☐ | A3 | Switch organization | Owner | Other org's data only | | |
| ☐ | A4 | Dashboard, Organizations, Settings | Owner | Pages open; Save policy enabled | | |
| ☐ | A5 | Create organization | Owner | Created message, Departments page | | |
| ☐ | B1 | Overview and rename | Owner | Name saved after reload | | |
| ☐ | B2 | Create department | Owner/Admin | Listed | | |
| ☐ | B3 | Create team | Owner/Admin | Under the right department | | |
| ☐ | B5 | Create project | Owner/Admin | Listed under the team | | |
| ☐ | B6 | Wrong parent in URL | Owner | Not available | | |
| ☐ | C2 | Search and filter members | Owner | People (x of n) | | |
| ☐ | C3 | Create invitation, copy link | Owner | One-time link shown | | |
| ☐ | C4 | Accept invitation (new account) | Admin / Employee / QA | Joined with invited role; inviter notified | | |
| ☐ | C5 | Change role | Owner | Role changed and logged | | |
| ☐ | C6 | Revoke invitation | Owner | Closed as revoked; link unusable | | |
| ☐ | C6 | Invitation expiry (after 7 days) | Owner | Expired, inviter notified | | |
| ☐ | C7 | Permissions per role | all | Matches the table in C7 | | |
| ☐ | C8 | Suspend and reactivate | Owner + Employee | No access while suspended; restored | | |
| ☐ | C9 | Organization isolation | Outsider | Not available, no data | | |
| ☐ | D1 | Workforce page | Admin | Directory, skills, policy | | |
| ☐ | D2 | Home team and skills | Admin | Team members, project visible to Employee | | |
| ☐ | D3 | Download three templates | Admin | CSV files | | |
| ☐ | D4 | Departments/teams CSV preview and confirm | Admin | 1 new, then unchanged on re-import | | |
| ☐ | D5 | Employee CSV import | Admin | Directory entries, no accounts | | |
| ☐ | D6 | CSV validation (role column, bad email, duplicate) | Admin | Rejected / error rows | | |
| ☐ | E1 | Create requirement | Admin | Draft | | |
| ☐ | E2 | Create tasks | Admin | To do | | |
| ☐ | E4 | Planning, due date, dependency | Admin | Saved; Start blocked by dependency | | |
| ☐ | E5 | Requirement Complete disabled while tasks open | Admin | Disabled with message | | |
| ☐ | F2 | Required skills and recommendations | Admin | Ranked list with reasons | | |
| ☐ | F3 | Manual assignment | Admin | Assignee set, To do, notified | | |
| ☐ | F4 | Decline assignment | Employee | Unassigned, in queue, managers notified | | |
| ☐ | F4 | Report blocker / Resume | Employee | Blocked with reason; back in progress | | |
| ☐ | F5 | Automatic policy and queue | Owner | Result message; no auto-assign without skills | | |
| ☐ | G1 | QA required | Manager | QA: Required | | |
| ☐ | G4 | Add link | Employee | Link listed | | |
| ☐ | G5 | Comment with @-mention | Employee | Mentioned person notified | | |
| ☐ | G6–G7 | Review → Send to QA | Employee, Manager | In QA, tester notified | | |
| ☐ | G8 | Report defect | QA | Back in progress, defect open | | |
| ☐ | G9 | Resolve defect | Employee | Resolved, QA notified | | |
| ☐ | G11 | Pass QA | QA | Completed | | |
| ☐ | G12 | Complete requirement | Manager | Completed | | |
| ☐ | G13 | Activity log and notifications | all | Full history | | |
| ☐ | G | Assignee cannot pass own QA | Employee | No Pass QA button | | |
| ☐ | G | Handoff to a QA team | Employee/Manager + QA team member | Accepted, responsible team changed | | |
| ☐ | G | Deadline notification | Employee | "Due …" notification | | |
| ☐ | H1 | Inspect repository | Owner | Repository card details | | |
| ☐ | H2 | Connect repository | Owner/Admin | Pending / Unknown | | |
| ☐ | H3 | Public GitHub import | Owner/Admin | Imported; re-import says Already imported | | |
| ☐ | H3 | Private GitHub import with token | Owner/Admin | Not verified; needs a real token | | |
| ☐ | H4 | ZIP upload | Owner/Admin | Completed with counts | | |
| ☐ | H5 | Snapshot and analysis status | any | Statuses shown separately | | |
| ☐ | H6 | Graph search, filters, zoom, focus, details | any team member | Works as described | | |
| ☐ | H6 | Large analysis exploration | any | Overview, file view, expand | | |
| ☐ | — | Jira Cloud connect and sync | Owner/Admin | Not verified; needs Jira credentials | | |
| ☐ | — | Email delivery | — | Blocked (no provider) | | |
| ☐ | I | Four-person journey | Owner, Admin, Employee, QA | Requirement completed with full history | | |

---

# PART 5 — Troubleshooting
Never use these as routine fixes: `npm run db:reset`, deleting Docker volumes, editing RLS policies, disabling security, or
rotating `STRUCTURE_PERSIST_KEY` or `INTEGRATION_ENCRYPTION_KEY`.

**5.1 App startup**
- *Port 3000 in use*: another dev server is running. Use it, or stop it in its own terminal.
- *Module or build errors*: run `npm install` once, then start again.
- *An existing page shows **This page isn’t available** in development*: stale Turbopack cache. Stop the server, then run
  `npm run dev:clean`.
- *Errors mentioning Supabase or fetch failures*: see 5.10.

**5.2 Login or organization selection**
- *No organizations on the dashboard*: this account has no active membership. Create one or accept an invitation.
- *Organization disappeared*: you were removed or suspended (the dashboard shows **Suspended access**). Ask an Owner.
- *Wrong organization's data*: reload the page; the URL decides which organization is shown.

**5.3 Permission denied / not found**
- **This page isn’t available** is used for "does not exist" and "not allowed" alike, on purpose. Check:
  - Is the role right (badge)?
  - Is the person in the project's team (Workforce home team)?
  - Are they suspended?
- Errors such as "You do not have permission to do that." or "Only owners and admins …" mean the database refused the action
  for this role.

**5.4 Forms stuck on loading / page not refreshing**
- After success, forms keep their button busy until the next page loads, then show a green confirmation once.
- If a button stays busy for more than about 30 seconds, reload the page and **check whether the change was saved** before
  retrying. This avoids duplicates.
- GitHub import and ZIP upload are long single requests; keep the page open.

**5.5 Invitation links**
- **No invitation found**: the link lost its `#…` part; paste the whole link.
- **Different account**: sign out and sign in with the invited email.
- **Invitation not available**: used, revoked or expired. Ask for a new one.
- One pending invitation per email: revoke the old one first.

**5.6 CSV validation**
- **Unknown column**: use the template header exactly.
- Columns `role`, `password`, `token`, `user_id`, `organization_id` reject the file.
- **unknown department**: import departments first.
- Save as **CSV UTF-8**; at most 512 KiB and 2,000 rows.
- **The data changed after the preview**: preview again, then confirm.

**5.7 Assignment and status transitions**
- *Person not in the eligible list*: not in the project's team or a collaborating team, **Unavailable**, or suspended.
- **The assignment changed in the meantime**: reload.
- *Cannot reassign*: tasks **In review**, **In QA**, **Completed** or **Cancelled** cannot be reassigned.
- **Start work** disabled: assign first, or finish dependencies.
- **Send to QA** / **Pass QA** disabled: resolve open defects.
- No **Approve**: QA is required.
- *Requirement **Complete** disabled*: tasks are still open.

**5.8 Repository import, upload and analysis**
- "GitHub rate limit reached": wait for the time shown.
- The archive is over 8 MiB: use a smaller commit or ZIP.
- **Processing** for more than 10 minutes: **Mark as failed**, then upload or import again.
- Analysis **Failed**: the message is on the snapshot page. Uploading the same archive again retries.
- *Integrations page says integrations are not configured*: `INTEGRATION_ENCRYPTION_KEY` is missing or too short in
  `.env.local`. Public imports still work. Ask the person who manages the environment; do not invent a key in shared
  environments.
- *Every ingestion is rejected with a signature error*: `STRUCTURE_PERSIST_KEY` and the Vault secret `structure_persist_key`
  differ. See `docs/manual-setup-checklist.md`, section 3. This is an administrator task, not a routine fix.

**5.9 Empty or incomplete graph**
- **No structure analysis for this snapshot** / **The structure analysis is not completed**: upload or import with analysis.
- **No symbols were extracted**: the language is unsupported, or files were excluded.
- A **+n** badge means relationships outside the current view: use **Expand neighbours**.
- No call edges is expected: the analyzer does not extract them.

**5.10 Supabase connection**
- Check Docker Desktop is running, then run `npx supabase status`. If stopped, run `npm run db:start`.
- Studio at `http://127.0.0.1:54323` lets you **look** at data. Avoid editing rows there during tests.
- Do not change `supabase/config.toml` or `.env.local` while testing.

---

# PART 6 — Reporting a failure
**Before sharing:** redact passwords, invitation links/tokens (everything after `#` in `/invitations#…`), API keys, session
cookies (`sb-…-auth-token`), access tokens, and personal information (real names, emails). Crop screenshots to the relevant
area.

```text
Step number and feature:
Account role:
Starting page:
Actions performed:
Expected result:
Actual result:
Exact error message:
Screenshot or sanitized logs:
Did the issue reproduce?:
Data affected, if any:
```
