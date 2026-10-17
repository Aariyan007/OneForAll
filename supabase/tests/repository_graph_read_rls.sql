-- Read functions for exploring large repository graphs (migration 20261020000001): privileges, RLS visibility per
-- role and tenant, server-side bounds and plain-text search. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_graph_read_rls.sql

set client_encoding = 'UTF8';
begin;

create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000e101';  -- OWNER of org 1
  ma     uuid := '00000000-0000-0000-0000-00000000e102';  -- MEMBER, team A (sees the project)
  mb     uuid := '00000000-0000-0000-0000-00000000e103';  -- MEMBER, team B (does not)
  owner2 uuid := '00000000-0000-0000-0000-00000000e201';  -- OWNER of org 2 (other tenant)
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; rx uuid;
  s1 uuid; sx uuid; an uuid; anx uuid; fa uuid; fb uuid; fx uuid;
  syms uuid[]; ids uuid[]; fn text; r record; n int; st text; i int;
begin
  insert into auth.users (id, email) values (owner1,'go1@g.local'),(ma,'gma@g.local'),(mb,'gmb@g.local'),(owner2,'go2@g.local');
  insert into public.organizations (name,slug,created_by) values ('Graph One','graph-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Graph Two','graph-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/g/p','g','p','main',owner1) returning id into r1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (px,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into rx;

  -- Org 1 snapshot: file a (1 module + 1200 functions), file b (1 class), one cross-file relationship. Org 2: one file.
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (rx,repeat('a',40),'main') returning id into sx;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'src/a.ts','TypeScript',1,repeat('1',64)) returning id into fa;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'src/lib/b.ts','TypeScript',1,repeat('1',64)) returning id into fb;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (sx,'secret.ts','TypeScript',1,repeat('1',64)) returning id into fx;
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id in (s1, sx);
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id in (s1, sx);
  insert into public.repository_structure_analyses (snapshot_id,status) values (s1,'PENDING') returning id into an;
  insert into public.repository_structure_analyses (snapshot_id,status) values (sx,'PENDING') returning id into anx;
  update public.repository_structure_analyses set status='PROCESSING', started_at=now() where id in (an, anx);
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column,visibility)
    values (an,fa,'a','MODULE',0,0,9999,0,'UNKNOWN');
  insert into public.repository_symbols (analysis_id,file_id,name,kind,qualified_name,start_line,start_column,end_line,end_column,visibility)
    select an, fa, 'fn_' || g, 'FUNCTION', 'a.fn_' || g, g, 0, g, 1, 'UNKNOWN' from generate_series(1, 1200) g;
  insert into public.repository_symbols (analysis_id,file_id,name,kind,qualified_name,start_line,start_column,end_line,end_column,visibility)
    values (an,fb,'100%_done','CLASS','lib.100%_done',0,0,5,0,'PUBLIC');
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column,visibility)
    values (anx,fx,'TopSecret','CLASS',0,0,1,0,'UNKNOWN');
  -- module a CONTAINS every function (1200 edges); fn_1 references the class in file b (cross-file).
  insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type)
    select an, m.id, f.id, 'CONTAINS' from public.repository_symbols m, public.repository_symbols f
    where m.analysis_id = an and m.kind = 'MODULE' and f.analysis_id = an and f.kind = 'FUNCTION';
  insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type)
    select an, f.id, c.id, 'REFERENCES' from public.repository_symbols f, public.repository_symbols c
    where f.analysis_id = an and f.name = 'fn_1' and c.analysis_id = an and c.kind = 'CLASS';
  update public.repository_structure_analyses set status='COMPLETED', completed_at=now(), files_total=2, files_analyzed=2, files_unsupported=0,
    files_failed=0, symbols_count=1202, relationships_count=1201 where id = an;
  update public.repository_structure_analyses set status='COMPLETED', completed_at=now(), files_total=1, files_analyzed=1, files_unsupported=0,
    files_failed=0, symbols_count=1, relationships_count=0 where id = anx;

  ---------------------------------------------------------------- catalog
  foreach fn in array array['public.repository_graph_overview(uuid)', 'public.repository_graph_summary(uuid)',
                            'public.repository_graph_search(uuid,text,integer)', 'public.repository_graph_symbols(uuid,uuid[],uuid,integer)',
                            'public.repository_graph_edges(uuid,uuid[],text[],integer)'] loop
    select p.prosecdef, p.proconfig, p.provolatile, p.proacl into r from pg_proc p where p.oid = fn::regprocedure;
    assert not r.prosecdef, fn || ': SECURITY INVOKER (RLS of the caller applies)';
    assert r.proconfig @> array['search_path=""'], fn || ': empty search_path';
    assert r.provolatile = 's', fn || ': STABLE (read-only)';
    assert has_function_privilege('authenticated', fn, 'execute'), fn || ': authenticated can execute';
    assert not has_function_privilege('anon', fn, 'execute'), fn || ': anon cannot execute';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0), fn || ': no PUBLIC execute';
  end loop;

  set local role anon;
  st := null; begin perform public.repository_graph_overview(an); exception when others then st := sqlstate; end;
  assert st = '42501', 'anon cannot call the overview';
  reset role;

  ---------------------------------------------------------------- OWNER and team MEMBER see the analysis
  set local role authenticated;
  foreach fn in array array[owner1::text, ma::text] loop
    perform public.zz_as(fn::uuid);
    select count(*), sum(symbols), sum(relationships), sum(external_relationships) into r from public.repository_graph_overview(an);
    assert r.count = 2 and r.sum = 1202, 'overview: 2 files, 1202 symbols for ' || fn;
    select relationships, external_relationships into r from public.repository_graph_overview(an) where path = 'src/a.ts';
    assert r.relationships = 1201 and r.external_relationships = 1, 'overview counts relationships by source file, external ones separately';
    select count(*) into n from public.repository_graph_summary(an);
    assert n = 5, 'summary: 3 kinds + 2 relationship types';
  end loop;

  ---------------------------------------------------------------- other team and other tenant see nothing
  foreach fn in array array[mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    select count(*) into n from public.repository_graph_overview(an);           assert n = 0, 'overview hidden from ' || fn;
    select count(*) into n from public.repository_graph_summary(an);            assert n = 0, 'summary hidden from ' || fn;
    select count(*) into n from public.repository_graph_search(an, 'fn', 50);   assert n = 0, 'search hidden from ' || fn;
    select count(*) into n from public.repository_graph_symbols(an, null, fa, 1000); assert n = 0, 'symbols by file hidden from ' || fn;
    select array_agg(id) into ids from public.repository_symbols where analysis_id = an; -- RLS: none visible
    assert ids is null, 'symbol rows hidden from ' || fn;
  end loop;
  -- org 1 owner probing org 2 by id gets nothing either
  perform public.zz_as(owner1);
  select count(*) into n from public.repository_graph_overview(anx);            assert n = 0, 'cross-tenant overview: nothing';
  select count(*) into n from public.repository_graph_search(anx, 'Top', 50);  assert n = 0, 'cross-tenant search: nothing';
  select count(*) into n from public.repository_graph_symbols(anx, null, fx, 1000); assert n = 0, 'cross-tenant file: nothing';
  reset role;
  select array_agg(id) into ids from public.repository_symbols where analysis_id = anx;
  set local role authenticated;
  perform public.zz_as(owner1);
  select count(*) into n from public.repository_graph_symbols(anx, ids, null, 1000); assert n = 0, 'cross-tenant symbols by forged id: nothing';
  select count(*) into n from public.repository_graph_edges(anx, ids, null, 2000);   assert n = 0, 'cross-tenant edges by forged id: nothing';
  -- org 1 ids with the org 2 analysis id cannot be mixed either
  select array_agg(id) into syms from public.repository_symbols where analysis_id = an and kind = 'MODULE';
  select count(*) into n from public.repository_graph_edges(anx, syms, null, 2000); assert n = 0, 'symbols of one analysis never match edges of another';

  ---------------------------------------------------------------- bounds enforced inside the functions
  select count(*), max(total_matches) into r from public.repository_graph_search(an, 'fn_', 100000);
  assert r.count = 50 and r.max = 1200, 'search returns at most 50 rows but reports all 1200 matches';
  select count(*) into n from public.repository_graph_search(an, 'fn_', -5);     assert n = 1, 'search limit floors at 1';
  select count(*) into n from public.repository_graph_search(an, '', 20);        assert n = 0, 'empty query matches nothing';
  select count(*) into n from public.repository_graph_search(an, repeat('x', 201), 20); assert n = 0, 'over-long query matches nothing';
  select count(*) into n from public.repository_graph_symbols(an, null, fa, 100000); assert n = 1000, 'symbols by file: at most 1000 rows';
  select count(*) into n from public.repository_graph_symbols(an, null, fa, 10);     assert n = 10, 'symbols by file: caller limit respected';
  select array_agg(id) into ids from public.repository_symbols where analysis_id = an; -- 1202 ids
  select count(*) into n from public.repository_graph_symbols(an, ids, null, 1000);  assert n = 0, 'more than 1000 ids are refused (no rows)';
  select count(*) into n from public.repository_graph_symbols(an, ids[1:1000], fa, 1000); assert n = 0, 'ids and file together are refused';
  select count(*) into n from public.repository_graph_edges(an, ids, null, 2000);    assert n = 0, 'edges: more than 1000 ids are refused';
  select count(*), max(total_relationships) into r from public.repository_graph_edges(an, syms, null, 100000);
  assert r.count = 1200 and r.max = 1200, 'edges of the module: all 1200 under the 2000 cap';
  select count(*), max(total_relationships) into r from public.repository_graph_edges(an, syms, null, 200);
  assert r.count = 200 and r.max = 1200, 'edges: caller limit applied, total reported';
  select count(*) into n from public.repository_graph_edges(an, syms, array['REFERENCES'], 2000);
  assert n = 0, 'relationship-type filter: the module has no REFERENCES';
  select count(*) into n from public.repository_graph_edges(an, array(select id from public.repository_symbols where analysis_id = an and name = 'fn_1'), array['REFERENCES'], 2000);
  assert n = 1, 'relationship-type filter: fn_1 has one REFERENCES';
  select count(*) into n from public.repository_graph_edges(an, '{}'::uuid[], null, 2000); assert n = 0, 'no ids, no edges';
  select degree into n from public.repository_graph_symbols(an, syms, null, 10);
  assert n = 1200, 'degree counts every stored relationship of the symbol';

  ---------------------------------------------------------------- search is plain text, never a pattern
  select count(*) into n from public.repository_graph_search(an, '100%', 20); assert n = 1, '% is matched literally';
  select count(*) into n from public.repository_graph_search(an, '%', 20);    assert n = 1, 'a lone % matches only names containing %';
  select count(*) into n from public.repository_graph_search(an, '_done', 20); assert n = 1, '_ is matched literally';
  select name into r from public.repository_graph_search(an, 'FN_12', 1);
  assert r.name = 'fn_12', 'case-insensitive; the exact match ranks first';
  select count(*) into n from public.repository_graph_search(an, 'lib.100', 20); assert n = 1, 'qualified names are searched';
  reset role;

  raise notice 'repository_graph_read_rls.sql: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
