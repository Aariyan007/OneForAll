-- Phase 2I source content store: the text of a snapshot's files, so later features (the AI assistant) can read the
-- exact code a snapshot recorded. Until now source code lived only in the memory of the ingestion request.
--
-- Rules:
--   * Text only (UTF-8, at most 1,000,000 bytes per file); binaries and larger files are simply not stored.
--   * Content is accepted only for a COMPLETED snapshot (its manifest is sealed) and only when SHA-256 of the UTF-8
--     bytes, computed HERE, equals the manifest's content_hash for that path. A caller therefore cannot store
--     anything except the exact bytes the signed manifest recorded; no extra signature is needed.
--   * Only OWNER/ADMIN of the snapshot's organization may store (the same people who ingest). Insert-only and
--     idempotent: a stored row is never changed; it is removed only with its file (cascade).
--   * Reads follow the parent: visible exactly when the file (so the snapshot, the project) is visible.
--   * Files excluded at ingestion (credentials, generated folders, oversized) have no manifest row, so no content.

create table public.repository_file_contents (
  file_id     uuid primary key references public.repository_files (id) on delete cascade,
  snapshot_id uuid not null references public.repository_snapshots (id) on delete cascade,
  content     text not null,
  byte_size   integer not null check (byte_size between 0 and 1000000),
  created_at  timestamptz not null default now()
);

create index repository_file_contents_snapshot_id_idx on public.repository_file_contents (snapshot_id);

alter table public.repository_file_contents enable row level security;

create policy "repository_file_contents_select_file_visible"
  on public.repository_file_contents for select
  to authenticated
  using (exists (
    select 1 from public.repository_files f where f.id = repository_file_contents.file_id
  ));

revoke all on public.repository_file_contents from anon, authenticated;
grant select on public.repository_file_contents to authenticated;

create or replace function private.enforce_file_content_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception 'Stored file content is immutable' using errcode = '55000';
end;
$$;

create trigger repository_file_contents_immutable
  before update on public.repository_file_contents
  for each row execute function private.enforce_file_content_immutability();

-- Stores a batch [{ "path": text, "content": text }, ...] for one COMPLETED snapshot. All or nothing: one bad element
-- refuses the batch. Returns how many rows were new and how many were already stored.
create or replace function public.store_snapshot_contents(p_snapshot_id uuid, p_files jsonb)
returns table (stored integer, already_stored integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_element jsonb;
  v_path text;
  v_content text;
  v_bytes integer;
  v_file record;
  v_stored integer := 0;
  v_existing integer := 0;
begin
  perform private.require_snapshot_admin(p_snapshot_id);
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) = 0 then
    raise exception 'Invalid content payload' using errcode = '22023';
  end if;
  if jsonb_array_length(p_files) > 1000 or octet_length(p_files::text) > 8388608 then
    raise exception 'Content batch too large' using errcode = '54000';
  end if;

  select s.status into v_status from public.repository_snapshots s where s.id = p_snapshot_id;
  if v_status is distinct from 'COMPLETED' then
    raise exception 'Content can only be stored for a COMPLETED snapshot' using errcode = '55000';
  end if;

  for v_element in select e from jsonb_array_elements(p_files) as e loop
    if jsonb_typeof(v_element) <> 'object' or jsonb_typeof(v_element -> 'path') <> 'string'
       or jsonb_typeof(v_element -> 'content') <> 'string' then
      raise exception 'Invalid content payload' using errcode = '22023';
    end if;
    v_path := v_element ->> 'path';
    v_content := v_element ->> 'content';
    v_bytes := octet_length(convert_to(v_content, 'UTF8'));
    if v_bytes > 1000000 then
      raise exception 'File content exceeds 1,000,000 bytes' using errcode = '22023';
    end if;

    select f.id, f.content_hash, f.size_bytes into v_file
    from public.repository_files f where f.snapshot_id = p_snapshot_id and f.path = v_path;
    if not found then
      raise exception 'Path is not in the snapshot manifest' using errcode = '23514';
    end if;
    if v_file.size_bytes <> v_bytes
       or encode(extensions.digest(convert_to(v_content, 'UTF8'), 'sha256'), 'hex') <> v_file.content_hash then
      raise exception 'Content does not match the recorded file' using errcode = '23514';
    end if;

    insert into public.repository_file_contents (file_id, snapshot_id, content, byte_size)
    values (v_file.id, p_snapshot_id, v_content, v_bytes)
    on conflict (file_id) do nothing;
    if found then v_stored := v_stored + 1; else v_existing := v_existing + 1; end if;
  end loop;

  return query select v_stored, v_existing;
end;
$$;

revoke all on function public.store_snapshot_contents(uuid, jsonb) from public, anon;
grant execute on function public.store_snapshot_contents(uuid, jsonb) to authenticated;
revoke all on function private.enforce_file_content_immutability() from public, anon, authenticated;

-- Plain-text, case-insensitive search over a snapshot's stored content. 1-based line numbers; a matching line is
-- returned without its line ending and cut to 300 characters. Bounded: query 2-200 characters, at most 50 rows.
-- SECURITY INVOKER: the caller's RLS decides which files are searched, so other teams and tenants get nothing.
create or replace function public.repository_code_search(p_snapshot_id uuid, p_query text, p_limit integer default 20)
returns table (path text, line_number integer, line text)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if p_query is null or char_length(p_query) not between 2 and 200 then
    raise exception 'Search text must be 2 to 200 characters' using errcode = '22023';
  end if;
  if p_limit is null or p_limit not between 1 and 50 then
    raise exception 'Limit must be 1 to 50' using errcode = '22023';
  end if;

  return query
  select f.path, l.n::integer, left(rtrim(l.txt, E'\r'), 300)
  from public.repository_file_contents c
  join public.repository_files f on f.id = c.file_id
  cross join lateral regexp_split_to_table(c.content, E'\n') with ordinality as l(txt, n)
  where c.snapshot_id = p_snapshot_id
    and strpos(lower(c.content), lower(p_query)) > 0
    and strpos(lower(l.txt), lower(p_query)) > 0
  order by f.path, l.n
  limit p_limit;
end;
$$;

revoke all on function public.repository_code_search(uuid, text, integer) from public, anon;
grant execute on function public.repository_code_search(uuid, text, integer) to authenticated;
