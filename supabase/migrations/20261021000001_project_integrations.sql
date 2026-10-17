-- Project integrations: GitHub source import and Jira Cloud issue import (one-way). Additive; existing data unchanged.
--
-- TRUST MODEL
--   * The browser and the Next.js server act as the same `authenticated` user, so anything the server can read back
--     through the Data API, an OWNER/ADMIN's browser could read too. Provider credentials are therefore stored only as
--     CIPHERTEXT, encrypted and decrypted exclusively by the server with the server-only INTEGRATION_ENCRYPTION_KEY
--     (AES-256-GCM, bound to the project and integration kind). The database never sees a plaintext token.
--   * Ciphertext lives in private.integration_credentials (no client privilege, not exposed by PostgREST) and is
--     reachable only through SECURITY DEFINER functions that re-check OWNER/ADMIN of the project's organization.
--   * Integration status and imported Jira issues are readable by everyone who can see the project (existing project
--     visibility via RLS) and writable only through the functions below. No client INSERT/UPDATE/DELETE grants.
--   * Disconnecting removes the credential and marks the integration DISCONNECTED; imported issues, requirements,
--     tasks and snapshots are never deleted by it.
--
-- GITHUB SOURCE: snapshots fetched by the server from GitHub for an exact commit are recorded with
-- source_kind = 'GITHUB_ARCHIVE' and verification = 'PROVIDER_FETCHED'. The source kind is part of the HMAC-signed
-- manifest (OFA-MANIFEST-V1), so only the server can record it; the verification value is derived from it here.

-- 1. Integration status (one row per project and kind) -------------------------------------------------------------

create table public.project_integrations (
  id                 uuid primary key default gen_random_uuid(),
  project_id         uuid not null references public.projects (id) on delete cascade,
  kind               text not null check (kind in ('GITHUB', 'JIRA')),
  status             text not null default 'CONNECTED' check (status in ('CONNECTED', 'ERROR', 'DISCONNECTED')),
  has_credential     boolean not null default false,
  -- Jira Cloud configuration (non-secret). Only https://<site>.atlassian.net hosts are accepted.
  jira_site          text check (jira_site ~ '^https://[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$'),
  jira_account_email text check (char_length(jira_account_email) between 3 and 320 and jira_account_email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
  jira_project_id    text check (jira_project_id ~ '^[0-9]{1,20}$'),
  jira_project_key   text check (jira_project_key ~ '^[A-Z][A-Z0-9_]{0,254}$'),
  jira_project_name  text check (char_length(jira_project_name) <= 255),
  -- Last operation (validation, sync or import), for the settings page.
  last_checked_at    timestamptz,
  last_sync_at       timestamptz,
  last_sync_status   text check (last_sync_status in ('SUCCEEDED', 'PARTIAL', 'FAILED')),
  last_sync_message  text check (char_length(last_sync_message) <= 500),
  last_error         text check (char_length(last_error) <= 500),
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint project_integrations_project_kind_key unique (project_id, kind),
  constraint project_integrations_jira_config check (kind = 'JIRA' or (jira_site is null and jira_account_email is null and jira_project_id is null))
);

create index project_integrations_project_idx on public.project_integrations (project_id);

alter table public.project_integrations enable row level security;
create policy "project_integrations_select_project_visible"
  on public.project_integrations for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_integrations.project_id));
revoke all on public.project_integrations from anon, authenticated;
grant select on public.project_integrations to authenticated;

-- 2. Encrypted credentials (private) -----------------------------------------------------------------------------

create table private.integration_credentials (
  integration_id uuid primary key references public.project_integrations (id) on delete cascade,
  -- "v1.<iv>.<tag>.<ciphertext>" (base64url), produced by src/server/integrations/crypto.ts. Never plaintext.
  ciphertext     text not null check (
                   char_length(ciphertext) <= 8192
                   and ciphertext ~ '^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{4,}$'
                 ),
  updated_at     timestamptz not null default now()
);
revoke all on private.integration_credentials from public, anon, authenticated;
alter table private.integration_credentials enable row level security; -- no policies

-- 3. Imported Jira issues (read-only mirror; Jira is authoritative for every mirrored field) ------------------------

create table public.jira_issues (
  id                uuid primary key default gen_random_uuid(),
  project_id        uuid not null references public.projects (id) on delete cascade,
  integration_id    uuid not null references public.project_integrations (id) on delete cascade,
  jira_site         text not null check (jira_site ~ '^https://[a-z0-9][a-z0-9-]{0,62}\.atlassian\.net$'),
  jira_project_key  text not null check (jira_project_key ~ '^[A-Z][A-Z0-9_]{0,254}$'),
  jira_issue_id     text not null check (jira_issue_id ~ '^[0-9]{1,20}$'),
  issue_key         text not null check (issue_key ~ '^[A-Z][A-Z0-9_]{0,254}-[0-9]{1,18}$'),
  summary           text not null check (char_length(summary) between 1 and 1000),
  status_name       text check (char_length(status_name) <= 100),
  status_category   text not null default 'unknown' check (status_category in ('new', 'indeterminate', 'done', 'unknown')),
  issue_type        text check (char_length(issue_type) <= 100),
  priority_name     text check (char_length(priority_name) <= 100),
  assignee_name     text check (char_length(assignee_name) <= 255),
  jira_updated_at   timestamptz,
  first_imported_at timestamptz not null default now(),
  last_synced_at    timestamptz not null default now(),
  -- Set when a COMPLETE sync no longer returns the issue (deleted, moved or no longer visible). Never deleted here.
  missing_in_source boolean not null default false,
  constraint jira_issues_issue_key unique (project_id, jira_site, jira_issue_id)
);

create index jira_issues_integration_idx on public.jira_issues (integration_id);
create index jira_issues_project_key_idx on public.jira_issues (project_id, issue_key);

alter table public.jira_issues enable row level security;
create policy "jira_issues_select_project_visible"
  on public.jira_issues for select to authenticated
  using (exists (select 1 from public.projects p where p.id = jira_issues.project_id));
revoke all on public.jira_issues from anon, authenticated;
grant select on public.jira_issues to authenticated;

-- 4. Helpers ---------------------------------------------------------------------------------------------------------

-- Raises 28000 / 42501 unless the caller is authenticated and OWNER/ADMIN of the project's organization.
create or replace function private.require_project_admin(p_project_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_org uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select d.organization_id into v_org
  from public.projects p
  join public.teams t on t.id = p.team_id
  join public.departments d on d.id = t.department_id
  where p.id = p_project_id;
  if v_org is null or not public.has_org_role(v_org, array['OWNER', 'ADMIN']) then
    raise exception 'Project not found' using errcode = '42501';
  end if;
end;
$$;

create or replace function private.integration_project(p_integration_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select i.project_id from public.project_integrations i where i.id = p_integration_id;
$$;

revoke all on function private.require_project_admin(uuid) from public, anon, authenticated;
revoke all on function private.integration_project(uuid) from public, anon, authenticated;

-- 5. Write functions (SECURITY DEFINER, OWNER/ADMIN only) ------------------------------------------------------------

-- Creates or updates the integration of a project. p_ciphertext NULL keeps the stored credential; p_clear_credential
-- removes it. Jira fields are validated by the table CHECKs. Returns the integration id.
create or replace function public.save_project_integration(
  p_project_id uuid,
  p_kind text,
  p_ciphertext text default null,
  p_clear_credential boolean default false,
  p_jira_site text default null,
  p_jira_account_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_project_admin(p_project_id);
  if p_kind not in ('GITHUB', 'JIRA') then
    raise exception 'Unknown integration kind' using errcode = '22023';
  end if;

  insert into public.project_integrations (project_id, kind, status, jira_site, jira_account_email, created_by)
  values (p_project_id, p_kind, 'CONNECTED', p_jira_site, p_jira_account_email, (select auth.uid()))
  on conflict (project_id, kind) do update
    set status = 'CONNECTED',
        -- A different Jira site or account invalidates the selected project.
        jira_project_id = case when public.project_integrations.jira_site is distinct from excluded.jira_site
                                 or public.project_integrations.jira_account_email is distinct from excluded.jira_account_email
                               then null else public.project_integrations.jira_project_id end,
        jira_project_key = case when public.project_integrations.jira_site is distinct from excluded.jira_site
                                  or public.project_integrations.jira_account_email is distinct from excluded.jira_account_email
                                then null else public.project_integrations.jira_project_key end,
        jira_project_name = case when public.project_integrations.jira_site is distinct from excluded.jira_site
                                   or public.project_integrations.jira_account_email is distinct from excluded.jira_account_email
                                 then null else public.project_integrations.jira_project_name end,
        jira_site = excluded.jira_site,
        jira_account_email = excluded.jira_account_email,
        last_error = null,
        updated_at = now()
  returning id into v_id;

  if p_clear_credential then
    delete from private.integration_credentials c where c.integration_id = v_id;
  elsif p_ciphertext is not null then
    insert into private.integration_credentials (integration_id, ciphertext) values (v_id, p_ciphertext)
    on conflict (integration_id) do update set ciphertext = excluded.ciphertext, updated_at = now();
  end if;

  update public.project_integrations i
  set has_credential = exists (select 1 from private.integration_credentials c where c.integration_id = v_id),
      last_checked_at = now()
  where i.id = v_id;
  return v_id;
end;
$$;

-- The stored ciphertext (or NULL). Useless without the server-only key; returned only to OWNER/ADMIN.
create or replace function public.get_integration_ciphertext(p_integration_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_project uuid := private.integration_project(p_integration_id);
  v_ciphertext text;
begin
  if v_project is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_project);
  select c.ciphertext into v_ciphertext from private.integration_credentials c where c.integration_id = p_integration_id;
  return v_ciphertext;
end;
$$;

create or replace function public.select_jira_project(p_integration_id uuid, p_project_id text, p_project_key text, p_project_name text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := private.integration_project(p_integration_id);
begin
  if v_project is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_project);
  update public.project_integrations i
  set jira_project_id = p_project_id, jira_project_key = p_project_key, jira_project_name = left(p_project_name, 255), updated_at = now()
  where i.id = p_integration_id and i.kind = 'JIRA';
  if not found then
    raise exception 'Not a Jira integration' using errcode = '22023';
  end if;
end;
$$;

-- Records the outcome of a validation, sync or import for the settings page.
create or replace function public.record_integration_result(
  p_integration_id uuid,
  p_status text,           -- integration status: CONNECTED | ERROR
  p_sync_status text,      -- SUCCEEDED | PARTIAL | FAILED, or NULL for a validation only
  p_message text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := private.integration_project(p_integration_id);
begin
  if v_project is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_project);
  if p_status not in ('CONNECTED', 'ERROR') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  update public.project_integrations i
  set status = case when i.status = 'DISCONNECTED' then i.status else p_status end,
      last_checked_at = now(),
      last_sync_at = case when p_sync_status is null then i.last_sync_at else now() end,
      last_sync_status = coalesce(p_sync_status, i.last_sync_status),
      last_sync_message = case when p_sync_status is null then i.last_sync_message else left(p_message, 500) end,
      last_error = case when p_status = 'ERROR' then left(p_message, 500) else null end,
      updated_at = now()
  where i.id = p_integration_id;
end;
$$;

-- Removes the credential and marks the integration DISCONNECTED. Imported issues and all other data are kept.
create or replace function public.disconnect_project_integration(p_integration_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_project uuid := private.integration_project(p_integration_id);
begin
  if v_project is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_project);
  delete from private.integration_credentials c where c.integration_id = p_integration_id;
  update public.project_integrations i
  set status = 'DISCONNECTED', has_credential = false, last_error = null, updated_at = now()
  where i.id = p_integration_id;
end;
$$;

-- Idempotent upsert of one page of Jira issues (at most 200) into the mirror of a CONNECTED Jira integration with a
-- selected project. Issues of another Jira project are refused. Returns (inserted, updated).
create or replace function public.upsert_jira_issues(p_integration_id uuid, p_issues jsonb, p_seen_at timestamptz)
returns table (inserted integer, updated integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_int record;
  v_inserted integer := 0;
  v_total integer;
begin
  select i.* into v_int from public.project_integrations i where i.id = p_integration_id;
  if v_int.id is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_int.project_id);
  if v_int.kind <> 'JIRA' or v_int.status = 'DISCONNECTED' or v_int.jira_project_key is null or v_int.jira_site is null then
    raise exception 'The Jira integration is not connected to a project' using errcode = '55000';
  end if;
  if jsonb_typeof(p_issues) is distinct from 'array' or jsonb_array_length(p_issues) > 200 or p_seen_at is null then
    raise exception 'Invalid issue batch' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_issues) e(obj)
    where jsonb_typeof(e.obj) is distinct from 'object'
       or jsonb_typeof(e.obj -> 'id') is distinct from 'string'
       or jsonb_typeof(e.obj -> 'key') is distinct from 'string'
       or jsonb_typeof(e.obj -> 'summary') is distinct from 'string'
       or split_part(e.obj ->> 'key', '-', 1) <> v_int.jira_project_key
  ) then
    raise exception 'Invalid issue in batch' using errcode = '22023';
  end if;

  select count(*) into v_total from jsonb_array_elements(p_issues);

  with incoming as (
    select e.obj ->> 'id' as jira_issue_id, e.obj ->> 'key' as issue_key, left(e.obj ->> 'summary', 1000) as summary,
           left(e.obj ->> 'status', 100) as status_name,
           case when e.obj ->> 'statusCategory' in ('new', 'indeterminate', 'done') then e.obj ->> 'statusCategory' else 'unknown' end as status_category,
           left(e.obj ->> 'issueType', 100) as issue_type, left(e.obj ->> 'priority', 100) as priority_name,
           left(e.obj ->> 'assignee', 255) as assignee_name, (e.obj ->> 'updated')::timestamptz as jira_updated_at
    from jsonb_array_elements(p_issues) e(obj)
  ),
  upserted as (
    insert into public.jira_issues as j
      (project_id, integration_id, jira_site, jira_project_key, jira_issue_id, issue_key, summary, status_name, status_category,
       issue_type, priority_name, assignee_name, jira_updated_at, last_synced_at, missing_in_source)
    select v_int.project_id, v_int.id, v_int.jira_site, v_int.jira_project_key, i.jira_issue_id, i.issue_key,
           coalesce(nullif(btrim(i.summary), ''), '(no summary)'), i.status_name, i.status_category, i.issue_type,
           i.priority_name, i.assignee_name, i.jira_updated_at, p_seen_at, false
    from incoming i
    on conflict (project_id, jira_site, jira_issue_id) do update
      set integration_id = excluded.integration_id, jira_project_key = excluded.jira_project_key, issue_key = excluded.issue_key,
          summary = excluded.summary, status_name = excluded.status_name, status_category = excluded.status_category,
          issue_type = excluded.issue_type, priority_name = excluded.priority_name, assignee_name = excluded.assignee_name,
          jira_updated_at = excluded.jira_updated_at, last_synced_at = excluded.last_synced_at, missing_in_source = false
    returning (xmax = 0) as is_insert
  )
  select count(*) filter (where is_insert) into v_inserted from upserted;

  return query select v_inserted, v_total - v_inserted;
end;
$$;

-- After a COMPLETE sync (every page fetched), issues of the selected Jira project that were not seen since
-- p_seen_at are marked missing_in_source (never deleted). Returns how many were newly marked.
create or replace function public.mark_missing_jira_issues(p_integration_id uuid, p_seen_at timestamptz)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_int record;
  v_count integer;
begin
  select i.* into v_int from public.project_integrations i where i.id = p_integration_id;
  if v_int.id is null then
    raise exception 'Integration not found' using errcode = '42501';
  end if;
  perform private.require_project_admin(v_int.project_id);
  if v_int.kind <> 'JIRA' or v_int.jira_project_key is null or p_seen_at is null then
    raise exception 'The Jira integration is not connected to a project' using errcode = '55000';
  end if;
  update public.jira_issues j
  set missing_in_source = true
  where j.project_id = v_int.project_id and j.jira_site = v_int.jira_site and j.jira_project_key = v_int.jira_project_key
    and j.last_synced_at < p_seen_at and not j.missing_in_source;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.save_project_integration(uuid, text, text, boolean, text, text) from public, anon;
grant execute on function public.save_project_integration(uuid, text, text, boolean, text, text) to authenticated;
revoke all on function public.get_integration_ciphertext(uuid) from public, anon;
grant execute on function public.get_integration_ciphertext(uuid) to authenticated;
revoke all on function public.select_jira_project(uuid, text, text, text) from public, anon;
grant execute on function public.select_jira_project(uuid, text, text, text) to authenticated;
revoke all on function public.record_integration_result(uuid, text, text, text) from public, anon;
grant execute on function public.record_integration_result(uuid, text, text, text) to authenticated;
revoke all on function public.disconnect_project_integration(uuid) from public, anon;
grant execute on function public.disconnect_project_integration(uuid) to authenticated;
revoke all on function public.upsert_jira_issues(uuid, jsonb, timestamptz) from public, anon;
grant execute on function public.upsert_jira_issues(uuid, jsonb, timestamptz) to authenticated;
revoke all on function public.mark_missing_jira_issues(uuid, timestamptz) from public, anon;
grant execute on function public.mark_missing_jira_issues(uuid, timestamptz) to authenticated;

-- 6. GitHub-fetched source archives --------------------------------------------------------------------------------

alter table public.repository_snapshot_sources drop constraint repository_snapshot_sources_source_kind_check;
alter table public.repository_snapshot_sources
  add constraint repository_snapshot_sources_source_kind_check check (source_kind in ('UPLOADED_ARCHIVE', 'GITHUB_ARCHIVE'));
alter table public.repository_snapshot_sources drop constraint repository_snapshot_sources_verification_check;
alter table public.repository_snapshot_sources
  add constraint repository_snapshot_sources_verification_check check (
    (source_kind = 'UPLOADED_ARCHIVE' and verification = 'UNVERIFIED')
    or (source_kind = 'GITHUB_ARCHIVE' and verification = 'PROVIDER_FETCHED')
  );

-- verification follows the (signed) source kind; nothing else can set it.
create or replace function private.set_source_verification()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.verification := case new.source_kind when 'GITHUB_ARCHIVE' then 'PROVIDER_FETCHED' else 'UNVERIFIED' end;
  return new;
end;
$$;
revoke all on function private.set_source_verification() from public, anon, authenticated;

create trigger repository_snapshot_sources_set_verification
  before insert on public.repository_snapshot_sources
  for each row execute function private.set_source_verification();

-- 7. Signed manifest version 2: sensitive files and the GitHub source kind -----------------------------------------
-- Files that commonly hold credentials (.env, private keys, .npmrc, ...) are excluded from the manifest and counted in
-- files_skipped_sensitive (NULL on rows written before this migration). The count is part of the signed message, whose
-- version line becomes OFA-MANIFEST-V2 (src/server/repository-files/signing.ts implements the same format).

alter table public.repository_snapshot_sources
  add column files_skipped_sensitive integer check (files_skipped_sensitive >= 0);
alter table public.repository_snapshot_sources drop constraint repository_snapshot_sources_exclusion_breakdown;
alter table public.repository_snapshot_sources
  add constraint repository_snapshot_sources_exclusion_breakdown check (
    (files_skipped_oversized is null and files_skipped_generated is null and files_skipped_metadata is null and files_skipped_sensitive is null)
    or (
      files_skipped_oversized is not null and files_skipped_generated is not null and files_skipped_metadata is not null
      and files_skipped_oversized + files_skipped_generated + files_skipped_metadata + coalesce(files_skipped_sensitive, 0) = files_skipped
    )
  );

create or replace function private.manifest_canonical(
  p_snapshot_id uuid,
  p_run_token   text,
  p_source      jsonb,
  p_files       jsonb
)
returns text
language sql
immutable
security invoker
set search_path = ''
as $$
  select 'OFA-MANIFEST-V2' || E'\n'
    || p_snapshot_id::text || E'\n'
    || p_run_token || E'\n'
    || 'SRC|' || coalesce(p_source ->> 'source_kind', '-')
    || '|' || coalesce(p_source ->> 'archive_format', '-')
    || '|' || coalesce(p_source ->> 'archive_sha256', '-')
    || '|' || coalesce(((p_source ->> 'archive_bytes')::bigint)::text, '-')
    || '|' || coalesce(p_source ->> 'archive_commit', '-')
    || '|' || coalesce(((p_source ->> 'entries_total')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_accepted')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_skipped')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_skipped_oversized')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_skipped_generated')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_skipped_metadata')::int)::text, '-')
    || '|' || coalesce(((p_source ->> 'files_skipped_sensitive')::int)::text, '-')
    || E'\n'
    || jsonb_array_length(p_files)::text || E'\n'
    || coalesce((
         select string_agg(
           'F|' || case when e.obj ->> 'path' is null then '-' else octet_length(e.obj ->> 'path')::text || ':' || (e.obj ->> 'path') end
             || '|' || case when e.obj ->> 'language' is null then '-' else octet_length(e.obj ->> 'language')::text || ':' || (e.obj ->> 'language') end
             || '|' || coalesce(((e.obj ->> 'size_bytes')::bigint)::text, '-')
             || '|' || coalesce(e.obj ->> 'content_hash', '-')
             || E'\n',
           '' order by e.ord)
         from jsonb_array_elements(p_files) with ordinality as e(obj, ord)
       ), '');
$$;

create or replace function private.manifest_payload_check(p_source jsonb, p_files jsonb)
returns void
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  c_int_max constant numeric := 2147483647;        -- integer columns
  c_size_max constant numeric := 9007199254740991; -- Number.MAX_SAFE_INTEGER, as the application checks
  v_key text;
  v_n int;
begin
  if jsonb_typeof(p_source) is distinct from 'object' or jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'Invalid manifest payload' using errcode = '22023';
  end if;

  -- Source record: known keys only, each with its exact type (absent or null keys are left to the table and the
  -- invariant checks, which reject them).
  for v_key in select k from jsonb_object_keys(p_source) k loop
    if v_key not in ('source_kind', 'archive_format', 'archive_sha256', 'archive_bytes', 'archive_commit', 'entries_total',
                     'files_accepted', 'files_skipped', 'files_skipped_oversized', 'files_skipped_generated', 'files_skipped_metadata',
                     'files_skipped_sensitive') then
      raise exception 'Invalid manifest source: unknown field %', left(v_key, 64) using errcode = '22023';
    end if;
    if jsonb_typeof(p_source -> v_key) = 'null' then
      continue;
    end if;
    if v_key in ('source_kind', 'archive_format', 'archive_sha256', 'archive_commit') then
      if jsonb_typeof(p_source -> v_key) <> 'string' then
        raise exception 'Invalid manifest source: % must be a string', v_key using errcode = '22023';
      end if;
    elsif v_key = 'archive_bytes' then
      if not private.manifest_is_int(p_source -> v_key, 1, c_size_max) then
        raise exception 'Invalid manifest source: % must be a positive integer', v_key using errcode = '22023';
      end if;
    elsif not private.manifest_is_int(p_source -> v_key, 0, c_int_max) then
      raise exception 'Invalid manifest source: % must be a non-negative integer', v_key using errcode = '22023';
    end if;
  end loop;

  v_n := jsonb_array_length(p_files);
  if v_n < 1 or v_n > 5000 then
    raise exception 'A snapshot needs between 1 and 5000 recorded files' using errcode = '23514';
  end if;

  -- File entries: an object with exactly these keys and types.
  if exists (
    select 1 from jsonb_array_elements(p_files) e(obj)
    where jsonb_typeof(e.obj) is distinct from 'object'
       or exists (select 1 from jsonb_object_keys(e.obj) k where k not in ('path', 'language', 'size_bytes', 'content_hash'))
       or jsonb_typeof(e.obj -> 'path') is distinct from 'string'
       or jsonb_typeof(e.obj -> 'content_hash') is distinct from 'string'
       or not private.manifest_is_int(e.obj -> 'size_bytes', 0, c_size_max)
       or (coalesce(jsonb_typeof(e.obj -> 'language'), 'null') <> 'null'
           and (jsonb_typeof(e.obj -> 'language') <> 'string' or (e.obj ->> 'language') !~ '^[A-Za-z][A-Za-z0-9+#]{0,49}$'))
  ) then
    raise exception 'Invalid manifest entry' using errcode = '22023';
  end if;

  -- Recording rules of the application: excluded folders are never recorded (directory segments only, like
  -- isIgnoredPath), nor is archive metadata (__MACOSX at the root, like the archive reader).
  if exists (
    select 1 from jsonb_array_elements(p_files) e(obj)
    where (e.obj ->> 'path') = '__MACOSX' or (e.obj ->> 'path') like '\_\_MACOSX/%'
       or exists (
         select 1 from unnest((string_to_array(e.obj ->> 'path', '/'))[1:cardinality(string_to_array(e.obj ->> 'path', '/')) - 1]) seg
         where seg in ('node_modules', '.git', 'dist', 'build', '.next', 'coverage'))
  ) then
    raise exception 'The manifest contains a path that is never recorded' using errcode = '23514';
  end if;

  -- Files that may hold credentials are never recorded (mirrors isSensitivePath in
  -- src/server/repository-sources/archive.ts: change both together).
  if exists (
    select 1 from jsonb_array_elements(p_files) e(obj),
         lateral (select lower(regexp_replace(e.obj ->> 'path', '^.*/', '')) as name) n
    where n.name not in ('.env.example', '.env.sample', '.env.template', '.env.dist')
      and (n.name = '.env' or n.name like '.env.%'
           or n.name in ('.npmrc', '.pypirc', '.netrc', '.git-credentials', '.htpasswd', 'id_rsa', 'id_dsa', 'id_ecdsa', 'id_ed25519')
           or n.name ~ '\.(pem|key|p12|pfx|jks|keystore)$')
  ) then
    raise exception 'The manifest contains a file that may hold credentials' using errcode = '23514';
  end if;

  -- Paths must be unambiguous: no exact, Unicode-normalization (NFC) or case-insensitive duplicates.
  if (select count(distinct lower(normalize(e.obj ->> 'path', NFC))) from jsonb_array_elements(p_files) e(obj)) <> v_n then
    raise exception 'Duplicate path in the manifest' using errcode = '23505';
  end if;
end;
$$;

create or replace function public.persist_snapshot_manifest(
  p_snapshot_id uuid,
  p_run_token   text,
  p_source      jsonb,
  p_files       jsonb,
  p_signature   text
)
returns table (snapshot_id uuid, status text, files_count integer)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
  v_commit text;
  v_stored_token text;
  v_count int;
  v_files int;
begin
  perform private.require_snapshot_admin(p_snapshot_id);
  if p_run_token is null or p_signature is null then
    raise exception 'Invalid manifest payload' using errcode = '22023';
  end if;

  -- 1. Shape, types, formats and recording rules (no key involved).
  perform private.manifest_payload_check(p_source, p_files);
  if p_signature !~ '^[0-9a-f]{64}$' then
    raise exception 'Malformed manifest signature' using errcode = '22023';
  end if;

  -- 2. State.
  select s.status, s.commit_sha into v_status, v_commit
  from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if not found then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
  if v_status <> 'PROCESSING' then
    raise exception 'Snapshot is not PROCESSING (it is %)', v_status using errcode = '55000';
  end if;

  -- 3. The run token binds the payload to THIS attempt.
  select r.run_token into v_stored_token from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;
  if v_stored_token is null or v_stored_token <> p_run_token then
    raise exception 'Invalid run token' using errcode = '42501';
  end if;

  -- 4. The signature proves the payload was produced by a holder of the server-only key. Verified before any write.
  if not private.manifest_signature_valid(private.manifest_canonical(p_snapshot_id, p_run_token, p_source, p_files), p_signature) then
    raise exception 'Invalid manifest signature' using errcode = '42501';
  end if;

  -- 5. Ingestion invariants (a signed but inconsistent manifest is still refused).
  v_count := jsonb_array_length(p_files);
  if (p_source ->> 'files_accepted')::int is distinct from v_count then
    raise exception 'files_accepted does not match the manifest' using errcode = '23514';
  end if;
  if p_source ->> 'files_skipped_oversized' is null or p_source ->> 'files_skipped_generated' is null
     or p_source ->> 'files_skipped_metadata' is null then
    raise exception 'The exclusion breakdown is required' using errcode = '23514';
  end if;
  -- Also enforced by repository_snapshot_sources CHECKs (20261016000001, 20261017000001); checked here explicitly.
  if (p_source ->> 'files_skipped_oversized')::int + (p_source ->> 'files_skipped_generated')::int
     + (p_source ->> 'files_skipped_metadata')::int + coalesce((p_source ->> 'files_skipped_sensitive')::int, 0)
     is distinct from (p_source ->> 'files_skipped')::int then
    raise exception 'The exclusion breakdown does not add up to files_skipped' using errcode = '23514';
  end if;
  if (p_source ->> 'files_accepted')::int + (p_source ->> 'files_skipped')::int > (p_source ->> 'entries_total')::int then
    raise exception 'More files recorded and excluded than the archive contains' using errcode = '23514';
  end if;
  if p_source ->> 'archive_commit' is not null and p_source ->> 'archive_commit' <> v_commit then
    raise exception 'The archive claims a different commit' using errcode = '23514';
  end if;

  -- 6. Write source record + manifest, then complete. One transaction: all of it or none of it.
  insert into public.repository_snapshot_sources
    (snapshot_id, source_kind, archive_format, archive_sha256, archive_bytes, archive_commit,
     entries_total, files_accepted, files_skipped,
     files_skipped_oversized, files_skipped_generated, files_skipped_metadata, files_skipped_sensitive, uploaded_by)
  values
    (p_snapshot_id, p_source ->> 'source_kind', p_source ->> 'archive_format', p_source ->> 'archive_sha256',
     (p_source ->> 'archive_bytes')::bigint, p_source ->> 'archive_commit',
     (p_source ->> 'entries_total')::int, (p_source ->> 'files_accepted')::int, (p_source ->> 'files_skipped')::int,
     (p_source ->> 'files_skipped_oversized')::int, (p_source ->> 'files_skipped_generated')::int,
     (p_source ->> 'files_skipped_metadata')::int, (p_source ->> 'files_skipped_sensitive')::int, (select auth.uid()));

  insert into public.repository_files (snapshot_id, path, language, size_bytes, content_hash)
  select p_snapshot_id, e.obj ->> 'path', e.obj ->> 'language', (e.obj ->> 'size_bytes')::bigint, e.obj ->> 'content_hash'
  from jsonb_array_elements(p_files) with ordinality as e(obj, ord)
  order by e.ord;

  select count(*) into v_files from public.repository_files f where f.snapshot_id = p_snapshot_id;
  if v_files <> v_count then
    raise exception 'The manifest was not recorded completely' using errcode = '23514';
  end if;

  update public.repository_snapshots s
  set status = 'COMPLETED', completed_at = now(), error_message = null
  where s.id = p_snapshot_id;

  delete from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, 'COMPLETED'::text, v_files;
end;
$$;

revoke all on function private.manifest_canonical(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.manifest_payload_check(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) to authenticated;
