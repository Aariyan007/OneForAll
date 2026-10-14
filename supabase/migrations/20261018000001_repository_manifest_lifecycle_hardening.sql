-- Repository manifest and snapshot-lifecycle hardening (additive; historical migrations are unchanged).
--
-- PROBLEM (security review of archive ingestion): 20261014000001 and 20261016000001 let any organization OWNER/ADMIN
-- write straight through the Data API (PostgREST):
--   * INSERT/DELETE public.repository_files while a snapshot is PENDING/PROCESSING (path, language, size and hash are
--     all client-supplied), so a manifest could be forged;
--   * INSERT/DELETE public.repository_snapshot_sources (the record of where the source came from and its counts);
--   * UPDATE status/started_at/completed_at/error_message of public.repository_snapshots, so a snapshot could be moved
--     PENDING -> PROCESSING -> COMPLETED with an empty, partial or forged manifest and no source record.
-- The browser and the Next.js server share the same `authenticated` principal, so grants and RLS alone cannot tell
-- the server-side ingestion from a hand-crafted request. Phase 2H solved the same problem for generated structure
-- (20261015000002); this migration applies that established pattern to the manifest and the snapshot lifecycle.
--
-- TRUST BOUNDARY (after this migration)
--   * Clients (authenticated) keep: SELECT on snapshots, manifest rows and source records (unchanged visibility),
--     creating a PENDING snapshot (create_repository_snapshot, unchanged) and DELETE of a whole snapshot (OWNER/ADMIN,
--     unchanged; the manifest and source record cascade).
--   * Clients lose: INSERT/DELETE on repository_files and repository_snapshot_sources, and every UPDATE of
--     repository_snapshots. Their insert/delete/update policies are dropped together with the grants.
--   * The lifecycle moves only through SECURITY DEFINER functions that re-check, inside the database, that the caller
--     is authenticated and OWNER/ADMIN of the organization derived from the snapshot (snapshot -> repository ->
--     project -> team -> department -> organization). An unknown snapshot and an unauthorized caller are
--     indistinguishable (42501):
--         begin_snapshot_ingestion(id)                 PENDING | FAILED -> PROCESSING  (issues a one-time run token,
--                                                      clears leftovers of an earlier attempt)
--         persist_snapshot_manifest(id, token, source, files, signature)
--                                                      PROCESSING -> COMPLETED: verifies token + HMAC, then writes the
--                                                      source record and the whole manifest and completes, atomically;
--                                                      the token is consumed
--         fail_snapshot_ingestion(id, token, message)  PROCESSING -> FAILED  (needs this run's token)
--         fail_stale_snapshot_ingestion(id)            PROCESSING -> FAILED  only after 10 minutes (crash recovery)
--   * An OWNER/ADMIN can call these functions directly, but cannot produce a manifest signature the database
--     accepts, so cannot forge, alter, re-target or replay a manifest, and cannot complete a snapshot without one.
--
-- KEY: the existing server-only HMAC key (env STRUCTURE_PERSIST_KEY, Vault secret 'structure_persist_key', read only
-- by private.structure_persist_key()). No new secret. Manifest messages start with their own version line
-- (OFA-MANIFEST-V1) and structure messages with OFA-STRUCTURE-V1, so a signature for one can never be valid for the
-- other.
--
-- CANONICAL SIGNED MESSAGE (version 1, UTF-8, every line ends with LF; implemented here in
-- private.manifest_canonical() and in src/server/repository-files/signing.ts, kept in agreement by a fixed test
-- vector in supabase/tests/repository_manifest_lifecycle_rls.sql):
--     OFA-MANIFEST-V1
--     <snapshot_id, lowercase uuid>
--     <run_token, 64 lowercase hex>
--     SRC|<source_kind>|<archive_format>|<archive_sha256>|<archive_bytes>|<archive_commit or ->|<entries_total>|<files_accepted>|<files_skipped>|<files_skipped_oversized>|<files_skipped_generated>|<files_skipped_metadata>
--     <number of files>
--     one line per file, in array order:
--       F|<S path>|<S language>|<size_bytes>|<content_hash>
--   where <S x> is "-" when x is NULL, otherwise "<UTF-8 byte length>:<x>". Integers are plain decimal.
--   signature = lowercase hex of HMAC-SHA256(key, message).
--
-- INVARIANTS checked by persist_snapshot_manifest (in addition to every table CHECK and the unique indexes):
--   1 to 5000 files; files_accepted = number of files; the three exclusion counts are present and add up to
--   files_skipped; archive_commit is NULL or equal to the snapshot's commit; the uploader is the caller. One
--   COMPLETED snapshot per repository and commit (existing partial unique index, 23505).
--
-- DEFENSE IN DEPTH: a manifest row is never UPDATEd, and no row is INSERTed into or DELETEd from the manifest of a
-- COMPLETED snapshot (the trigger holds even for SECURITY DEFINER code; cascades from deleting the snapshot or anything
-- above it still work). The
-- existing status-transition trigger still validates every status change. A run token can exist only for a
-- PROCESSING snapshot.

-- 1. Run tokens (private schema: not exposed by PostgREST, no privilege for any client role) ------------------

create table private.snapshot_ingestion_runs (
  snapshot_id uuid primary key references public.repository_snapshots (id) on delete cascade,
  run_token   text not null check (run_token ~ '^[0-9a-f]{64}$'),
  created_at  timestamptz not null default now()
);
revoke all on private.snapshot_ingestion_runs from public, anon, authenticated;
alter table private.snapshot_ingestion_runs enable row level security; -- no policies: only the owner can touch it

create or replace function private.enforce_snapshot_run_window()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.repository_snapshots s where s.id = new.snapshot_id and s.status = 'PROCESSING'
  ) then
    raise exception 'An ingestion run token can only exist for a PROCESSING snapshot' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger snapshot_ingestion_runs_enforce_window
  before insert or update on private.snapshot_ingestion_runs
  for each row execute function private.enforce_snapshot_run_window();

-- 2. Helpers (private; executed only inside the definer functions below) ---------------------------------------

create or replace function private.snapshot_org(p_snapshot_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = ''
as $$
  select d.organization_id
  from public.repository_snapshots s
  join public.repositories r on r.id = s.repository_id
  join public.projects p on p.id = r.project_id
  join public.teams t on t.id = p.team_id
  join public.departments d on d.id = t.department_id
  where s.id = p_snapshot_id;
$$;

-- Raises 28000 / 42501 unless the caller is authenticated and OWNER/ADMIN of the snapshot's organization.
create or replace function private.require_snapshot_admin(p_snapshot_id uuid)
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
  v_org := private.snapshot_org(p_snapshot_id);
  if v_org is null or not public.has_org_role(v_org, array['OWNER', 'ADMIN']) then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
end;
$$;

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
  select 'OFA-MANIFEST-V1' || E'\n'
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

-- Removes a snapshot's manifest, source record and run token. Only for a snapshot that is not COMPLETED (the manifest
-- trigger below refuses a COMPLETED manifest anyway).
create or replace function private.clear_snapshot_ingestion(p_snapshot_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$
  delete from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;
  delete from public.repository_files f where f.snapshot_id = p_snapshot_id;
  delete from public.repository_snapshot_sources s where s.snapshot_id = p_snapshot_id;
$$;

revoke all on function private.enforce_snapshot_run_window() from public, anon, authenticated;
revoke all on function private.snapshot_org(uuid) from public, anon, authenticated;
revoke all on function private.require_snapshot_admin(uuid) from public, anon, authenticated;
revoke all on function private.manifest_canonical(uuid, text, jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.clear_snapshot_ingestion(uuid) from public, anon, authenticated;

-- 3. Remove every direct client write path to the manifest, the source record and the snapshot lifecycle -------

drop policy repository_files_insert_admin on public.repository_files;
drop policy repository_files_delete_admin on public.repository_files;
revoke all on public.repository_files from anon, authenticated;
grant select on public.repository_files to authenticated;

drop policy repository_snapshot_sources_insert_admin on public.repository_snapshot_sources;
drop policy repository_snapshot_sources_delete_admin on public.repository_snapshot_sources;
revoke all on public.repository_snapshot_sources from anon, authenticated;
grant select on public.repository_snapshot_sources to authenticated;

-- Snapshots: SELECT, INSERT of a PENDING snapshot and DELETE stay exactly as before; no UPDATE of any column.
drop policy repository_snapshots_update_admin on public.repository_snapshots;
revoke all on public.repository_snapshots from anon, authenticated;
grant select on public.repository_snapshots to authenticated;
grant insert (repository_id, commit_sha, branch, status) on public.repository_snapshots to authenticated;
grant delete on public.repository_snapshots to authenticated;

-- A manifest row is never updated, and the manifest of a COMPLETED snapshot is sealed (no insert, no delete).
-- Cascading deletes (snapshot, repository, project, ... removed) are unaffected: the parent snapshot is already gone
-- when the cascade runs.
create or replace function public.enforce_repository_file_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'Manifest rows are immutable' using errcode = '23514';
  end if;
  if exists (
    select 1 from public.repository_snapshots s
    where s.id = case when tg_op = 'INSERT' then new.snapshot_id else old.snapshot_id end and s.status = 'COMPLETED'
  ) then
    raise exception 'The manifest of a COMPLETED snapshot is immutable' using errcode = '23514';
  end if;
  return case when tg_op = 'INSERT' then new else old end;
end;
$$;

create trigger repository_files_enforce_immutability
  before insert or update or delete on public.repository_files
  for each row execute function public.enforce_repository_file_immutability();

-- 4. Lifecycle functions (SECURITY DEFINER: they re-check authorization themselves) ---------------------------

create or replace function public.begin_snapshot_ingestion(p_snapshot_id uuid)
returns table (snapshot_id uuid, run_token text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
  v_repository uuid;
  v_commit text;
  v_token text;
begin
  perform private.require_snapshot_admin(p_snapshot_id);

  -- The row lock serializes concurrent uploads: the second caller waits, then sees PROCESSING.
  select s.status, s.repository_id, s.commit_sha into v_status, v_repository, v_commit
  from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if v_status = 'PROCESSING' then
    raise exception 'Snapshot is already being processed' using errcode = '55000';
  end if;
  if v_status not in ('PENDING', 'FAILED') then
    raise exception 'Snapshot cannot be ingested (it is %)', v_status using errcode = '55000';
  end if;
  if exists (
    select 1 from public.repository_snapshots s
    where s.repository_id = v_repository and s.commit_sha = v_commit and s.status = 'COMPLETED' and s.id <> p_snapshot_id
  ) then
    raise exception 'A completed snapshot of this commit already exists' using errcode = '23505';
  end if;

  -- Retry: FAILED -> PENDING first (both steps are validated by the status-transition trigger).
  if v_status = 'FAILED' then
    update public.repository_snapshots s
    set status = 'PENDING', started_at = null, completed_at = null, error_message = null
    where s.id = p_snapshot_id;
  end if;

  update public.repository_snapshots s
  set status = 'PROCESSING', started_at = now(), completed_at = null, error_message = null
  where s.id = p_snapshot_id;

  -- A new attempt starts from nothing: leftovers of an earlier attempt are replaced, never mixed in.
  perform private.clear_snapshot_ingestion(p_snapshot_id);

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  insert into private.snapshot_ingestion_runs (snapshot_id, run_token) values (p_snapshot_id, v_token);

  return query select p_snapshot_id, v_token;
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
  v_key text;
  v_message text;
  v_count int;
  v_files int;
begin
  perform private.require_snapshot_admin(p_snapshot_id);
  if p_run_token is null or p_signature is null
     or jsonb_typeof(p_source) is distinct from 'object' or jsonb_typeof(p_files) is distinct from 'array' then
    raise exception 'Invalid manifest payload' using errcode = '22023';
  end if;

  select s.status, s.commit_sha into v_status, v_commit
  from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if v_status <> 'PROCESSING' then
    raise exception 'Snapshot is not PROCESSING (it is %)', v_status using errcode = '55000';
  end if;

  -- 1. The run token binds the payload to THIS attempt (replaced by every begin, deleted on completion or failure).
  select r.run_token into v_stored_token from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;
  if v_stored_token is null or v_stored_token <> p_run_token then
    raise exception 'Invalid run token' using errcode = '42501';
  end if;

  -- 2. The HMAC proves the manifest was produced by a holder of the server-only key. Verified BEFORE any write,
  --    compared as HMAC(supplied) = HMAC(expected) so the comparison does not depend on where the strings differ.
  v_key := private.structure_persist_key();
  v_message := private.manifest_canonical(p_snapshot_id, p_run_token, p_source, p_files);
  if extensions.hmac(convert_to(p_signature, 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256')
     <> extensions.hmac(convert_to(private.structure_hmac(v_message, v_key), 'UTF8'), convert_to(v_key, 'UTF8'), 'sha256') then
    raise exception 'Invalid manifest signature' using errcode = '42501';
  end if;

  -- 3. Ingestion invariants (independent of the signature: a signed but inconsistent manifest is still refused).
  v_count := jsonb_array_length(p_files);
  if v_count < 1 or v_count > 5000 then
    raise exception 'A snapshot needs between 1 and 5000 recorded files' using errcode = '23514';
  end if;
  if (p_source ->> 'files_accepted')::int is distinct from v_count then
    raise exception 'files_accepted does not match the manifest' using errcode = '23514';
  end if;
  if p_source ->> 'files_skipped_oversized' is null or p_source ->> 'files_skipped_generated' is null
     or p_source ->> 'files_skipped_metadata' is null then
    raise exception 'The exclusion breakdown is required' using errcode = '23514';
  end if;
  if p_source ->> 'archive_commit' is not null and p_source ->> 'archive_commit' <> v_commit then
    raise exception 'The archive claims a different commit' using errcode = '23514';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_files) e(obj)
    where jsonb_typeof(e.obj) is distinct from 'object' or e.obj ->> 'path' is null
       or e.obj ->> 'size_bytes' is null or e.obj ->> 'content_hash' is null
  ) then
    raise exception 'Invalid manifest entry' using errcode = '22023';
  end if;

  -- 4. Write source record + manifest, then complete. One transaction: all of it or none of it.
  insert into public.repository_snapshot_sources
    (snapshot_id, source_kind, archive_format, archive_sha256, archive_bytes, archive_commit,
     entries_total, files_accepted, files_skipped,
     files_skipped_oversized, files_skipped_generated, files_skipped_metadata, uploaded_by)
  values
    (p_snapshot_id, p_source ->> 'source_kind', p_source ->> 'archive_format', p_source ->> 'archive_sha256',
     (p_source ->> 'archive_bytes')::bigint, p_source ->> 'archive_commit',
     (p_source ->> 'entries_total')::int, (p_source ->> 'files_accepted')::int, (p_source ->> 'files_skipped')::int,
     (p_source ->> 'files_skipped_oversized')::int, (p_source ->> 'files_skipped_generated')::int,
     (p_source ->> 'files_skipped_metadata')::int, (select auth.uid()));

  insert into public.repository_files (snapshot_id, path, language, size_bytes, content_hash)
  select p_snapshot_id, e.obj ->> 'path', e.obj ->> 'language', (e.obj ->> 'size_bytes')::bigint, e.obj ->> 'content_hash'
  from jsonb_array_elements(p_files) with ordinality as e(obj, ord)
  order by e.ord;

  select count(*) into v_files from public.repository_files f where f.snapshot_id = p_snapshot_id;
  if v_files <> v_count then
    raise exception 'The manifest was not recorded completely' using errcode = '23514';
  end if;

  -- 23505 here: another snapshot of this commit completed meanwhile; everything above is rolled back.
  update public.repository_snapshots s
  set status = 'COMPLETED', completed_at = now(), error_message = null
  where s.id = p_snapshot_id;

  -- The token is consumed: this attempt can never be persisted (or replayed) again.
  delete from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;

  return query select p_snapshot_id, 'COMPLETED'::text, v_files;
end;
$$;

create or replace function public.fail_snapshot_ingestion(p_snapshot_id uuid, p_run_token text, p_error_message text)
returns table (snapshot_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
  v_stored_token text;
begin
  perform private.require_snapshot_admin(p_snapshot_id);

  select s.status into v_status from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if v_status <> 'PROCESSING' then
    raise exception 'Snapshot is not PROCESSING (it is %)', v_status using errcode = '55000';
  end if;
  select r.run_token into v_stored_token from private.snapshot_ingestion_runs r where r.snapshot_id = p_snapshot_id;
  if p_run_token is null or v_stored_token is null or v_stored_token <> p_run_token then
    raise exception 'Invalid run token' using errcode = '42501';
  end if;

  perform private.clear_snapshot_ingestion(p_snapshot_id);
  update public.repository_snapshots s
  set status = 'FAILED', completed_at = now(),
      error_message = left(coalesce(nullif(btrim(p_error_message), ''), 'Snapshot ingestion failed.'), 2000)
  where s.id = p_snapshot_id;

  return query select p_snapshot_id, 'FAILED'::text;
end;
$$;

-- Crash/disconnect recovery without the run token: only for a snapshot that has been PROCESSING for 10 minutes or
-- more (the same threshold as STALE_PROCESSING_MILLIS in the application).
create or replace function public.fail_stale_snapshot_ingestion(p_snapshot_id uuid)
returns table (snapshot_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_status text;
  v_started timestamptz;
begin
  perform private.require_snapshot_admin(p_snapshot_id);

  select s.status, s.started_at into v_status, v_started
  from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if v_status <> 'PROCESSING' then
    raise exception 'Snapshot is not PROCESSING (it is %)', v_status using errcode = '55000';
  end if;
  if v_started is not null and v_started > now() - interval '10 minutes' then
    raise exception 'Snapshot started processing recently' using errcode = '55000';
  end if;

  perform private.clear_snapshot_ingestion(p_snapshot_id);
  update public.repository_snapshots s
  set status = 'FAILED', completed_at = now(),
      error_message = 'Processing did not finish. Upload the archive again to retry.'
  where s.id = p_snapshot_id;

  return query select p_snapshot_id, 'FAILED'::text;
end;
$$;

revoke all on function public.enforce_repository_file_immutability() from public, anon, authenticated;
revoke all on function public.begin_snapshot_ingestion(uuid) from public, anon;
grant execute on function public.begin_snapshot_ingestion(uuid) to authenticated;
revoke all on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) to authenticated;
revoke all on function public.fail_snapshot_ingestion(uuid, text, text) from public, anon;
grant execute on function public.fail_snapshot_ingestion(uuid, text, text) to authenticated;
revoke all on function public.fail_stale_snapshot_ingestion(uuid) from public, anon;
grant execute on function public.fail_stale_snapshot_ingestion(uuid) to authenticated;
