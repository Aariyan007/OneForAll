-- Project graph: file-to-file IMPORTS edges, so the repository graph covers the whole project (directories, files,
-- symbols from the structure analysis, and the dependencies between files).
--
-- Edges are derived data: computed by the server from the stored source text (src/lib/project-graph/imports.ts) and
-- written through store_file_edges, which replaces the snapshot's edges in one transaction. Only OWNER/ADMIN of the
-- snapshot's organization may store them, only for COMPLETED snapshots, and only between files of that snapshot.
-- Reads follow the file's visibility (RLS), like every other repository table.

create table public.repository_file_edges (
  id             bigint generated always as identity primary key,
  snapshot_id    uuid not null references public.repository_snapshots (id) on delete cascade,
  source_file_id uuid not null references public.repository_files (id) on delete cascade,
  target_file_id uuid not null references public.repository_files (id) on delete cascade,
  kind           text not null check (kind in ('IMPORTS')),
  specifier      text not null check (char_length(specifier) between 1 and 500),
  created_at     timestamptz not null default now(),
  unique (snapshot_id, source_file_id, target_file_id, kind),
  check (source_file_id <> target_file_id)
);

create index repository_file_edges_snapshot_idx on public.repository_file_edges (snapshot_id);
create index repository_file_edges_source_idx on public.repository_file_edges (source_file_id);
create index repository_file_edges_target_idx on public.repository_file_edges (target_file_id);

alter table public.repository_file_edges enable row level security;

create policy "repository_file_edges_select_file_visible"
  on public.repository_file_edges for select
  to authenticated
  using (exists (select 1 from public.repository_files f where f.id = repository_file_edges.source_file_id));

revoke all on public.repository_file_edges from anon, authenticated;
grant select on public.repository_file_edges to authenticated;

create or replace function public.store_file_edges(p_snapshot_id uuid, p_edges jsonb)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status text;
  v_element jsonb;
  v_source uuid;
  v_target uuid;
  v_count integer := 0;
begin
  perform private.require_snapshot_admin(p_snapshot_id);
  if p_edges is null or jsonb_typeof(p_edges) <> 'array' then
    raise exception 'Invalid edge payload' using errcode = '22023';
  end if;
  if jsonb_array_length(p_edges) > 50000 then
    raise exception 'Too many edges' using errcode = '54000';
  end if;
  select s.status into v_status from public.repository_snapshots s where s.id = p_snapshot_id;
  if v_status is distinct from 'COMPLETED' then
    raise exception 'Edges can only be stored for a COMPLETED snapshot' using errcode = '55000';
  end if;

  delete from public.repository_file_edges e where e.snapshot_id = p_snapshot_id;

  for v_element in select e from jsonb_array_elements(p_edges) as e loop
    if jsonb_typeof(v_element) <> 'object' or jsonb_typeof(v_element -> 'source') <> 'string'
       or jsonb_typeof(v_element -> 'target') <> 'string' or jsonb_typeof(v_element -> 'specifier') <> 'string' then
      raise exception 'Invalid edge' using errcode = '22023';
    end if;
    select f.id into v_source from public.repository_files f where f.snapshot_id = p_snapshot_id and f.path = v_element ->> 'source';
    select f.id into v_target from public.repository_files f where f.snapshot_id = p_snapshot_id and f.path = v_element ->> 'target';
    if v_source is null or v_target is null or v_source = v_target then
      raise exception 'Edge refers to files that are not in the snapshot' using errcode = '23514';
    end if;
    insert into public.repository_file_edges (snapshot_id, source_file_id, target_file_id, kind, specifier)
    values (p_snapshot_id, v_source, v_target, 'IMPORTS', left(v_element ->> 'specifier', 500))
    on conflict (snapshot_id, source_file_id, target_file_id, kind) do nothing;
    if found then v_count := v_count + 1; end if;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.store_file_edges(uuid, jsonb) from public, anon;
grant execute on function public.store_file_edges(uuid, jsonb) to authenticated;
