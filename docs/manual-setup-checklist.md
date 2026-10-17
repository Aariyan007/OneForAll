# Manual setup checklist

Everything a person has to do by hand: accounts, keys, tokens and permissions. Never paste real values into issues, chat,
docs, commits or test fixtures. `.env.local` is git-ignored; keep it that way.

## 1. Local development
| # | Step | Command or place |
| --- | --- | --- |
| 1 | Install Node.js 20+, Docker Desktop, and the dependencies | `npm install` |
| 2 | Start local Supabase. Migrations in `supabase/migrations` are applied to a **new** local database on first start. | `npm run db:start` |
| 3 | Copy `.env.example` to `.env.local` and fill it in (section 2) | — |
| 4 | Read the local URL and publishable key | `npx supabase status` |
| 5 | Create the HMAC key and store it in **both** `.env.local` and Vault (section 3) | — |
| 6 | Optional: create `INTEGRATION_ENCRYPTION_KEY` (section 4) | — |
| 7 | Start the app. If an existing route returns the not-found page in development, use `npm run dev:clean` (see `docs/repository-graph.md`). | `npm run dev` |
| 8 | Sign up at `http://localhost:3000`. Email confirmation is off locally (`supabase/config.toml`). | browser |

**Existing local database:** apply only the migrations that are new to it. Do **not** run `npm run db:reset` on a database whose
data you want to keep; it drops and recreates everything.

```bash
npx supabase migration up
```

Migrations not yet committed in this phase: `20261020000001_repository_graph_read_functions.sql` and
`20261021000001_project_integrations.sql`. Both are additive.

## 2. Environment variables
| Name | Where | Secret | Required | Value |
| --- | --- | --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | browser and server | no | yes | Supabase API URL (local: `http://127.0.0.1:54321`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | browser and server | no (RLS protects data) | yes | publishable (anon) key from `npx supabase status` or the dashboard |
| `NEXT_PUBLIC_SITE_URL` | server | no | yes | absolute app origin, for auth email links (local: `http://localhost:3000`) |
| `STRUCTURE_PERSIST_KEY` | server only | **yes** | yes, for snapshot ingestion and structure analysis | 32+ random characters; the same value goes in Vault |
| `INTEGRATION_ENCRYPTION_KEY` | server only | **yes** | only to store GitHub or Jira credentials | 32+ random characters; **not** stored in Vault |

- Server-only variables must never get a `NEXT_PUBLIC_` prefix.
- No Supabase service-role key is used anywhere. Do not add one.
- Generate a random value with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. `STRUCTURE_PERSIST_KEY` and the Vault secret
The server signs every structure analysis and file manifest with this key. The database verifies each signature with its copy in
Supabase Vault, named **`structure_persist_key`**. If the two differ, every ingestion and analysis is rejected.

1. Generate a value (section 2) and put it in `.env.local` as `STRUCTURE_PERSIST_KEY=...`.
2. Store the same value in Vault. Use the SQL editor in Supabase Studio (local: `http://127.0.0.1:54323`) or `psql` as `postgres`, and replace the placeholder:

```sql
select vault.create_secret('<the same value>', 'structure_persist_key', 'Structure and manifest HMAC key');
```

3. Restart the app.
4. **Rotation:** update both places together, using `vault.update_secret` for Vault. Existing data stays valid: signatures are checked
   only when data is written.
5. **Hosted Supabase:** do the same in the project's SQL editor and set the variable in the hosting provider's server environment.

## 4. `INTEGRATION_ENCRYPTION_KEY`
- The server encrypts GitHub and Jira tokens with it (AES-256-GCM). The database stores only ciphertext.
- Set it in the server environment only. It does **not** go into Vault: the database must not be able to decrypt the tokens.
- If it is missing, the Integrations page says integrations are not configured. Public GitHub imports still work.
- **Changing or losing it** makes stored tokens unreadable. Admins then enter them again. No other data is affected.
- Use a different value in every environment (local, staging, production).

## 5. GitHub (optional; needed for private repositories or more than 60 requests per hour)
Public repositories need nothing. For a token:

1. Go to GitHub → Settings → Developer settings → **Personal access tokens → Fine-grained tokens → Generate new token**.
2. **Resource owner:** the user or organization that owns the repository. An organization may first need to allow fine-grained tokens and approve the request.
3. **Repository access:** *Only select repositories*, then pick the repository.
4. **Permissions:** Repository → **Contents: Read-only**. Metadata: Read-only is added automatically. Nothing else.
5. Set an expiry date and note it. An expired token gives "GitHub rejected the token"; save a new one.
6. In OneForAll: **Project → Integrations → GitHub → Access**. Paste the token and save. As an OWNER/ADMIN, paste it only into that field, never into chat or a document.
7. **Still to test:** an import of a real **private** repository with such a token has not been run yet. Test it and record the result in `docs/phase-handover.md`.

No OAuth app, GitHub App, callback URL or webhook is needed.

## 6. Jira Cloud (optional)
1. Use an Atlassian account that has **Browse projects** permission on the Jira project. A dedicated, least-privilege account is best.
2. Create an API token at <https://id.atlassian.com/manage-profile/security/api-tokens> (a classic API token, not a scoped one). Set an expiry date.
3. In OneForAll: **Project → Integrations → Jira Cloud**. Enter the site (`your-company.atlassian.net`), the account email and the
   token, then **Connect**.
4. Choose the Jira project, then click **Sync now**.
5. **Still to test:** connect, project list and sync have not been run against a real Jira site yet. Test them with a Jira Cloud site you may use, and record the result in `docs/phase-handover.md`.

No OAuth app or callback URL is needed. Only Jira **Cloud** (`*.atlassian.net`) is supported, not Jira Data Center or Server.

## 7. Before deploying (not done in this phase)
- [ ] Apply the new migrations to the hosted database, after review, with `npx supabase db push` from a linked project. **Back up first.**
- [ ] Set `STRUCTURE_PERSIST_KEY` and `INTEGRATION_ENCRYPTION_KEY` in the host's server environment. Create the Vault secret in the hosted project.
- [ ] Set the Auth site URL and redirect URLs in the Supabase dashboard to the deployed origin (`/auth/callback`).
- [ ] The host must accept request bodies of at least 9 MiB on the upload route and allow 120 s per request on the upload and integration routes. See `docs/repository-ingestion.md` → limits.
- [ ] Outbound HTTPS from the server must reach `api.github.com`, `codeload.github.com` and `*.atlassian.net`.
