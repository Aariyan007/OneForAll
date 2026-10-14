-- Manifest payload validation and lifecycle robustness (additive; replaces function bodies from 20261018000001).
--
-- FINDINGS (security review of 20261018000001), each probed against a signed payload before this migration:
--   1. Type confusion was accepted: numbers sent as JSON strings ("100"), and path / content_hash / language sent as JSON
--      numbers. The values were cast silently. Now every field must have its exact JSON type, and integers must be
--      plain decimal integers inside the column's range.
--   2. Unknown keys in the source object and in file entries were silently ignored. They are now rejected.
--   3. `language` accepted any 1-50 character string, including control characters. It must now look like a language
--      name (letters, digits, '+', '#'), which is what detectLanguage() produces.
--   4. Paths that the application never records were accepted: NFC-equivalent or case-insensitive duplicates (the
--      archive reader rejects these as ambiguous) and paths inside the folders that ingestion excludes
--      (IGNORED_DIRECTORIES in src/server/repository-files/manifest.ts, and __MACOSX/ archive metadata).
--   5. Malformed signatures were only rejected by the HMAC mismatch. They are now rejected up front (22023); the HMAC is
--      compared on raw bytes. pgcrypto has no constant-time equality, so the comparison stays a double HMAC: both
--      sides are HMAC'd again with the key before comparing, so the comparison time is independent of how many leading
--      bytes of a guess are correct.
--   6. TOCTOU: if a snapshot was deleted between the authorization check and the row lock, the lifecycle functions
--      read a NULL status and fell through (fail_stale_snapshot_ingestion could even report FAILED without changing
--      anything). Every function now refuses when the locked row no longer exists.
--   7. Hygiene: the Phase 2H trigger function private.enforce_run_row_window still had the default PUBLIC EXECUTE. It
--      was unreachable (no client has USAGE on the private schema, and trigger functions cannot be called directly).
--      It is now revoked like every other private helper.
--
-- ORDER inside persist_snapshot_manifest: authorization -> payload shape, types and formats (cheap, no key) -> row lock
-- and state -> run token -> signature -> ingestion invariants -> writes. Business invariants stay after the signature,
-- so an unsigned caller learns nothing about them.
--
-- Mirrors of application rules live in private.manifest_payload_check(); keep them in step with
-- src/server/repository-files/manifest.ts and src/server/repository-sources/archive.ts.

-- 1. Helpers (private; no client privilege) ----------------------------------------------------------------------------

-- True when v is a JSON number written as a plain integer within [lo, hi].
create or replace function private.manifest_is_int(v jsonb, lo numeric, hi numeric)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(jsonb_typeof(v) = 'number' and (v #>> '{}') ~ '^-?[0-9]{1,19}$'
                  and (v #>> '{}')::numeric between lo and hi, false);
$$;

-- Raises unless the payload has exactly the shape the application sends. Checks only shape, types, formats and the
-- application's recording rules; the ingestion invariants (counts, commit claim) are checked after the signature.
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
                     'files_accepted', 'files_skipped', 'files_skipped_oversized', 'files_skipped_generated', 'files_skipped_metadata') then
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

  -- Paths must be unambiguous: no exact, Unicode-normalization (NFC) or case-insensitive duplicates.
  if (select count(distinct lower(normalize(e.obj ->> 'path', NFC))) from jsonb_array_elements(p_files) e(obj)) <> v_n then
    raise exception 'Duplicate path in the manifest' using errcode = '23505';
  end if;
end;
$$;

-- Lowercase hex HMAC-SHA256 signature check on raw bytes, as a double HMAC (see finding 5).
create or replace function private.manifest_signature_valid(p_message text, p_signature text)
returns boolean
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_key bytea := convert_to(private.structure_persist_key(), 'UTF8');
begin
  return extensions.hmac(decode(p_signature, 'hex'), v_key, 'sha256')
       = extensions.hmac(extensions.hmac(convert_to(p_message, 'UTF8'), v_key, 'sha256'), v_key, 'sha256');
end;
$$;

revoke all on function private.manifest_is_int(jsonb, numeric, numeric) from public, anon, authenticated;
revoke all on function private.manifest_payload_check(jsonb, jsonb) from public, anon, authenticated;
revoke all on function private.manifest_signature_valid(text, text) from public, anon, authenticated;
revoke all on function private.enforce_run_row_window() from public, anon, authenticated;

-- 2. Lifecycle functions (same signatures, grants re-asserted below) -------------------------------------------------

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

  select s.status, s.repository_id, s.commit_sha into v_status, v_repository, v_commit
  from public.repository_snapshots s where s.id = p_snapshot_id for update;
  if not found then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
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

  if v_status = 'FAILED' then
    update public.repository_snapshots s
    set status = 'PENDING', started_at = null, completed_at = null, error_message = null
    where s.id = p_snapshot_id;
  end if;

  update public.repository_snapshots s
  set status = 'PROCESSING', started_at = now(), completed_at = null, error_message = null
  where s.id = p_snapshot_id;

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
     + (p_source ->> 'files_skipped_metadata')::int is distinct from (p_source ->> 'files_skipped')::int then
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

  update public.repository_snapshots s
  set status = 'COMPLETED', completed_at = now(), error_message = null
  where s.id = p_snapshot_id;

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
  if not found then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
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
  if not found then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
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

revoke all on function public.begin_snapshot_ingestion(uuid) from public, anon;
grant execute on function public.begin_snapshot_ingestion(uuid) to authenticated;
revoke all on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) from public, anon;
grant execute on function public.persist_snapshot_manifest(uuid, text, jsonb, jsonb, text) to authenticated;
revoke all on function public.fail_snapshot_ingestion(uuid, text, text) from public, anon;
grant execute on function public.fail_snapshot_ingestion(uuid, text, text) to authenticated;
revoke all on function public.fail_stale_snapshot_ingestion(uuid) from public, anon;
grant execute on function public.fail_stale_snapshot_ingestion(uuid) to authenticated;
