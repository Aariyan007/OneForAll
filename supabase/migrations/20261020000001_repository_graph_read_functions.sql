-- Read-only, bounded queries for exploring large repository graphs. Additive: no table, column, policy or grant on
-- existing objects changes, and nothing here writes.
--
-- WHY: the graph page used to load every symbol and relationship of an analysis into one response, so it refused
-- analyses over 5,000 symbols. Large analyses are now explored in bounded pieces (an overview, a file, the neighbours
-- of a symbol, a search), and these pieces need aggregation, plain-text search and lookups by many ids, which the
-- Data API cannot express safely or within URL limits.
--
-- SECURITY: every function is SECURITY INVOKER with an empty search_path. It runs as the caller, so the existing RLS
-- policies of repository_symbols, repository_symbol_relationships and repository_files decide what is visible, exactly
-- as for direct reads: an analysis of another tenant, or of a project outside the caller's teams, simply yields no
-- rows. EXECUTE is granted to `authenticated` only (revoked from PUBLIC and anon). The application additionally
-- verifies the organization -> ... -> snapshot -> analysis chain before calling them.
--
-- BOUNDS: every result is limited inside the function; callers cannot request more than the stated maximums.

-- Per-file overview of one analysis: only files that have symbols. `relationships` counts relationships whose source
-- symbol is in the file; `external_relationships` those whose target is in a different file. Bounded by the manifest
-- (at most 5,000 files per snapshot).
create or replace function public.repository_graph_overview(p_analysis_id uuid)
returns table (file_id uuid, path text, symbols integer, relationships integer, external_relationships integer)
language sql
stable
security invoker
set search_path = ''
as $$
  with syms as (
    select s.id, s.file_id from public.repository_symbols s where s.analysis_id = p_analysis_id
  ),
  per_file as (
    select syms.file_id, count(*)::integer as symbols from syms group by syms.file_id
  ),
  rel_counts as (
    select a.file_id,
           count(*)::integer as relationships,
           (count(*) filter (where b.file_id <> a.file_id))::integer as external_relationships
    from public.repository_symbol_relationships r
    join syms a on a.id = r.source_symbol_id
    join syms b on b.id = r.target_symbol_id
    where r.analysis_id = p_analysis_id
    group by a.file_id
  )
  select f.id, f.path, pf.symbols, coalesce(rc.relationships, 0), coalesce(rc.external_relationships, 0)
  from per_file pf
  join public.repository_files f on f.id = pf.file_id
  left join rel_counts rc on rc.file_id = pf.file_id
  order by f.path
  limit 5000;
$$;

-- Counts per symbol kind and per relationship type (a handful of rows).
create or replace function public.repository_graph_summary(p_analysis_id uuid)
returns table (category text, name text, total integer)
language sql
stable
security invoker
set search_path = ''
as $$
  select 'kind'::text, s.kind, count(*)::integer
  from public.repository_symbols s where s.analysis_id = p_analysis_id group by s.kind
  union all
  select 'relationship'::text, r.relationship_type, count(*)::integer
  from public.repository_symbol_relationships r where r.analysis_id = p_analysis_id group by r.relationship_type;
$$;

-- Case-insensitive substring search on the symbol name and qualified name. The query is compared as plain text
-- (strpos), never as a pattern. Exact matches first, then prefixes, then other matches. At most 50 rows; total_matches
-- is the number of matches before the limit.
create or replace function public.repository_graph_search(p_analysis_id uuid, p_query text, p_limit integer default 20)
returns table (id uuid, name text, kind text, qualified_name text, file_id uuid, path text, start_line integer, total_matches bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (select lower(btrim(coalesce(p_query, ''))) as text),
  matches as (
    select s.id, s.name, s.kind, s.qualified_name, s.file_id, s.start_line,
           case when lower(s.name) = q.text or lower(coalesce(s.qualified_name, '')) = q.text then 0
                when starts_with(lower(s.name), q.text) then 1
                else 2 end as rank
    from public.repository_symbols s, q
    where s.analysis_id = p_analysis_id
      and char_length(q.text) between 1 and 200
      and (strpos(lower(s.name), q.text) > 0 or strpos(lower(coalesce(s.qualified_name, '')), q.text) > 0)
  )
  select m.id, m.name, m.kind, m.qualified_name, m.file_id, f.path, m.start_line, count(*) over ()
  from matches m
  join public.repository_files f on f.id = m.file_id
  order by m.rank, char_length(m.name), m.name, f.path, m.start_line, m.id
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

-- Symbols of one analysis, either by id (at most 1,000 ids) or all symbols of one file (at most p_limit, max 1,000),
-- each with its total number of stored relationships (`degree`), so the caller can state how many of a symbol's
-- relationships it has loaded. Pass exactly one of p_ids / p_file_id.
create or replace function public.repository_graph_symbols(
  p_analysis_id uuid,
  p_ids uuid[] default null,
  p_file_id uuid default null,
  p_limit integer default 1000
)
returns table (
  id uuid, analysis_id uuid, file_id uuid, path text, name text, kind text, qualified_name text, signature text,
  start_line integer, start_column integer, end_line integer, visibility text, degree integer
)
language sql
stable
security invoker
set search_path = ''
as $$
  select s.id, s.analysis_id, s.file_id, f.path, s.name, s.kind, s.qualified_name, s.signature,
         s.start_line, s.start_column, s.end_line, s.visibility,
         (select count(*)::integer from public.repository_symbol_relationships r
           where r.analysis_id = p_analysis_id and (r.source_symbol_id = s.id or r.target_symbol_id = s.id))
  from public.repository_symbols s
  join public.repository_files f on f.id = s.file_id
  where s.analysis_id = p_analysis_id
    and ((p_ids is not null and p_file_id is null and cardinality(p_ids) <= 1000 and s.id = any (p_ids))
      or (p_file_id is not null and p_ids is null and s.file_id = p_file_id))
  order by f.path, s.start_line, s.start_column, s.id
  limit least(greatest(coalesce(p_limit, 1000), 1), 1000);
$$;

-- Relationships of one analysis that touch any of the given symbols (at most 1,000 ids), optionally only of the given
-- types. At most p_limit rows (max 2,000), ordered deterministically; total_relationships is the number that match
-- before the limit, so a caller can say exactly how many it did not load.
create or replace function public.repository_graph_edges(
  p_analysis_id uuid,
  p_symbol_ids uuid[],
  p_types text[] default null,
  p_limit integer default 500
)
returns table (id uuid, analysis_id uuid, source_symbol_id uuid, target_symbol_id uuid, relationship_type text, total_relationships bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.id, r.analysis_id, r.source_symbol_id, r.target_symbol_id, r.relationship_type, count(*) over ()
  from public.repository_symbol_relationships r
  where r.analysis_id = p_analysis_id
    and p_symbol_ids is not null and cardinality(p_symbol_ids) between 1 and 1000
    and (r.source_symbol_id = any (p_symbol_ids) or r.target_symbol_id = any (p_symbol_ids))
    and (p_types is null or r.relationship_type = any (p_types))
  order by r.relationship_type, r.source_symbol_id, r.target_symbol_id, r.id
  limit least(greatest(coalesce(p_limit, 500), 1), 2000);
$$;

revoke all on function public.repository_graph_overview(uuid) from public, anon;
grant execute on function public.repository_graph_overview(uuid) to authenticated;
revoke all on function public.repository_graph_summary(uuid) from public, anon;
grant execute on function public.repository_graph_summary(uuid) to authenticated;
revoke all on function public.repository_graph_search(uuid, text, integer) from public, anon;
grant execute on function public.repository_graph_search(uuid, text, integer) to authenticated;
revoke all on function public.repository_graph_symbols(uuid, uuid[], uuid, integer) from public, anon;
grant execute on function public.repository_graph_symbols(uuid, uuid[], uuid, integer) to authenticated;
revoke all on function public.repository_graph_edges(uuid, uuid[], text[], integer) from public, anon;
grant execute on function public.repository_graph_edges(uuid, uuid[], text[], integer) to authenticated;
