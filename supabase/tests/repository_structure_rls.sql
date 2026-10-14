-- Phase 2H authorization, isolation, integrity, lifecycle and SIGNED-PERSISTENCE checks for code-structure
-- intelligence (repository_structure_analyses, repository_symbols, repository_symbol_relationships, the lifecycle
-- functions and persist_structure_analysis). One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_structure_rls.sql
-- The test installs its OWN HMAC key in Vault inside the transaction (rolled back), so it never needs, reads or
-- changes the real key.

set client_encoding = 'UTF8';
begin;

-- Test helpers (public schema, exist only inside this rolled-back transaction) ---------------------------------
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- Signs a payload exactly as the application does (canonical message + HMAC-SHA256), with an explicit key.
create function public.zz_sig(p_analysis uuid, p_token text, p_syms jsonb, p_rels jsonb,
                              ft int, fa int, fu int, ff int, p_key text default null)
returns text language sql security definer set search_path = '' as $$
  select private.structure_hmac(
    private.structure_canonical(p_analysis, p_token, p_syms, p_rels, ft, fa, fu, ff),
    coalesce(p_key, private.structure_persist_key()));
$$;

create function public.zz_sym(p_file uuid, p_name text, p_kind text default 'CLASS', p_qn text default null,
                              p_sig text default null, sl int default 0, sc int default 0, el int default 1, ec int default 0,
                              p_vis text default 'UNKNOWN')
returns jsonb language sql immutable as $$
  select jsonb_build_object('file_id', p_file, 'name', p_name, 'kind', p_kind, 'qualified_name', p_qn, 'signature', p_sig,
                            'start_line', sl, 'start_column', sc, 'end_line', el, 'end_column', ec, 'visibility', p_vis);
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-000000000a01';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-000000000a02';  -- ADMIN of org 1 (in no team)
  ma     uuid := '00000000-0000-0000-0000-000000000a03';  -- MEMBER, dept 1, team A
  mb     uuid := '00000000-0000-0000-0000-000000000a04';  -- MEMBER, dept 1, team B   (same dept, different team)
  mdept  uuid := '00000000-0000-0000-0000-000000000a05';  -- MEMBER, dept 1, NO team
  mx     uuid := '00000000-0000-0000-0000-000000000a06';  -- MEMBER of org 1, no dept, no team
  mo     uuid := '00000000-0000-0000-0000-000000000a07';  -- MEMBER, dept 2, team C   (other department)
  owner2 uuid := '00000000-0000-0000-0000-000000000b01';  -- OWNER of org 2 (other tenant)
  m2     uuid := '00000000-0000-0000-0000-000000000b02';  -- MEMBER of org 2, team BB
  h1     text := repeat('1', 64);
  test_key text := 'phase2h-test-key-0123456789abcdefghij';
  other_key text := 'a-different-key-0123456789abcdefghijk';
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; deptb uuid;
  team_a uuid; team_b uuid; team_c uuid; team_bb uuid;
  p_a uuid; p_b uuid; p_bb uuid;
  repo_a uuid; repo_b uuid; repo_bb uuid;
  s_a uuid; s_a2 uuid; s_a_pend uuid; s_a_fail uuid; s_b uuid; s_bb uuid; s_val uuid;
  f_a1 uuid; f_a2 uuid; f_a3 uuid; f_a2_1 uuid; f_b uuid; f_bb uuid;
  an_a uuid; an_a2 uuid; an_b uuid; an_bb uuid; an_v uuid;
  tok_a text; tok_a2 text; tok_b text; tok_old text; tok_new text; tok_x text;
  vid uuid; sy_svc uuid; sy_helper uuid;
  base_syms jsonb; base_rels jsonb; sig text; syms2 jsonb;
  vec_key text; vec_canonical text; vec_sig text; vec_symbols jsonb; vec_rels jsonb;
  r record; v record; n int; n2 int; caught boolean; msg text;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values
    (owner1,'o1@h.local'),(admin1,'a1@h.local'),(ma,'ma@h.local'),(mb,'mb@h.local'),(mdept,'md@h.local'),
    (mx,'mx@h.local'),(mo,'mo@h.local'),(owner2,'o2@h.local'),(m2,'m2@h.local');
  insert into public.organizations (name,slug,created_by) values ('Org One','org-one-h',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Org Two','org-two-h',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values
    (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org1,mdept,'MEMBER'),
    (org1,mx,'MEMBER'),(org1,mo,'MEMBER'),(org2,owner2,'OWNER'),(org2,m2,'MEMBER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'Engineering','engineering',owner1) returning id into dept1;
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'HR','hr',owner1) returning id into dept2;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'Engineering','engineering',owner2) returning id into deptb;
  insert into public.department_members (department_id,user_id) values (dept1,ma),(dept1,mb),(dept1,mdept),(dept2,mo),(deptb,m2);
  insert into public.teams (department_id,name,slug,created_by) values (dept1,'Team A','team-a',owner1) returning id into team_a;
  insert into public.teams (department_id,name,slug,created_by) values (dept1,'Team B','team-b',owner1) returning id into team_b;
  insert into public.teams (department_id,name,slug,created_by) values (dept2,'Team C','team-c',owner1) returning id into team_c;
  insert into public.teams (department_id,name,slug,created_by) values (deptb,'Team BB','team-bb',owner2) returning id into team_bb;
  insert into public.team_members (team_id,user_id) values (team_a,ma),(team_b,mb),(team_c,mo),(team_bb,m2);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'Payments','payments','BROWNFIELD',owner1) returning id into p_a;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_b,'Hiring','hiring','BROWNFIELD',owner1) returning id into p_b;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_bb,'Payments','payments','BROWNFIELD',owner2) returning id into p_bb;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_a,'GITHUB','https://github.com/acme/payments','acme','payments','main',owner1) returning id into repo_a;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_b,'GITHUB','https://github.com/acme/hiring','acme','hiring','main',owner1) returning id into repo_b;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_bb,'GITHUB','https://github.com/globex/payments','globex','payments','main',owner2) returning id into repo_bb;

  -- Manifests are recorded while the snapshots are PENDING, then the snapshots are completed (a COMPLETED manifest is
  -- sealed for every writer since migration 20261018000001).
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,repeat('a',40),'main') returning id into s_a;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,repeat('b',40),'main') returning id into s_a2;
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_a,repeat('e',40),'main','COMPLETED',now(),now()) returning id into s_val;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,repeat('c',40),'main') returning id into s_a_pend;
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a,repeat('d',40),'main','FAILED') returning id into s_a_fail;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_b,repeat('a',40),'main') returning id into s_b;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_bb,repeat('a',40),'main') returning id into s_bb;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'src/index.ts','TypeScript',10,h1) returning id into f_a1;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'src/util.py','Python',20,h1) returning id into f_a2;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'README.md',null,5,h1) returning id into f_a3;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a2,'src/other.ts','TypeScript',10,h1) returning id into f_a2_1;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_b,'src/hiring.py','Python',20,h1) returning id into f_b;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_bb,'src/index.ts','TypeScript',10,h1) returning id into f_bb;
  update public.repository_snapshots set status = 'PROCESSING', started_at = now() where id in (s_a, s_a2, s_b, s_bb);
  update public.repository_snapshots set status = 'COMPLETED', completed_at = now() where id in (s_a, s_a2, s_b, s_bb);

  -- The HMAC key in Vault (inside this transaction only) ----------------------
  select id into vid from vault.secrets where name = 'structure_persist_key';
  if vid is null then
    perform vault.create_secret(test_key, 'structure_persist_key', 'phase 2h test key');
  else
    perform vault.update_secret(vid, test_key);
  end if;
  caught := false;
  begin caught := (private.structure_persist_key() = test_key); exception when others then caught := false; end;
  assert caught, 'the key reader returns exactly the key stored in the Vault';

  ---------------------------------------------------------------- catalog: shape, RLS, grants, private objects
  assert (select relrowsecurity from pg_class where oid = 'public.repository_structure_analyses'::regclass), 'analyses: RLS enabled';
  assert (select relrowsecurity from pg_class where oid = 'public.repository_symbols'::regclass), 'symbols: RLS enabled';
  assert (select relrowsecurity from pg_class where oid = 'public.repository_symbol_relationships'::regclass), 'relationships: RLS enabled';
  select count(*) into n from information_schema.columns
    where table_schema = 'public'
      and table_name in ('repository_structure_analyses','repository_symbols','repository_symbol_relationships')
      and column_name in ('organization_id','department_id','team_id','project_id','repository_id','content','source','source_code','body','run_token','hmac','persist_signature');
  assert n = 0, 'no ownership shortcut, source-content, run-token or HMAC column on the structure tables; saw ' || n;
  assert not has_table_privilege('anon','public.repository_structure_analyses','select'), 'anon: no analyses privilege';
  assert not has_table_privilege('anon','public.repository_symbols','select'), 'anon: no symbols privilege';
  assert not has_table_privilege('anon','public.repository_symbol_relationships','select'), 'anon: no relationships privilege';
  -- generated structure: read-only for every client role
  for v in select t, p from unnest(array['repository_symbols','repository_symbol_relationships']) as t, unnest(array['insert','update','delete','truncate']) as p loop
    assert not has_table_privilege('authenticated', 'public.' || v.t, v.p), format('authenticated has no table-level %s on %s', v.p, v.t);
    assert not has_table_privilege('anon', 'public.' || v.t, v.p), format('anon has no %s on %s', v.p, v.t);
  end loop;
  assert has_table_privilege('authenticated','public.repository_symbols','select'), 'authenticated can read symbols (RLS-scoped)';
  assert has_table_privilege('authenticated','public.repository_symbol_relationships','select'), 'authenticated can read relationships (RLS-scoped)';
  for v in select c, p from (select attname as c from pg_attribute where attrelid = 'public.repository_symbols'::regclass and attnum > 0 and not attisdropped) a, unnest(array['insert','update']) as p loop
    assert not has_column_privilege('authenticated','public.repository_symbols', v.c, v.p), format('no column %s on repository_symbols.%s', v.p, v.c);
  end loop;
  for v in select c, p from (select attname as c from pg_attribute where attrelid = 'public.repository_symbol_relationships'::regclass and attnum > 0 and not attisdropped) a, unnest(array['insert','update']) as p loop
    assert not has_column_privilege('authenticated','public.repository_symbol_relationships', v.c, v.p), format('no column %s on repository_symbol_relationships.%s', v.p, v.c);
  end loop;
  assert (select count(*) from pg_policies where tablename in ('repository_symbols','repository_symbol_relationships') and cmd in ('INSERT','UPDATE','DELETE','ALL')) = 0,
    'symbols/relationships: no INSERT/UPDATE/DELETE/ALL policy remains';
  -- analyses: no UPDATE of any column; insert only (snapshot_id, status)
  assert not has_table_privilege('authenticated','public.repository_structure_analyses','update'), 'analyses: no table-level UPDATE';
  for v in select attname as c from pg_attribute where attrelid = 'public.repository_structure_analyses'::regclass and attnum > 0 and not attisdropped loop
    assert not has_column_privilege('authenticated','public.repository_structure_analyses', v.c, 'update'), format('analyses: column %s is not updatable by clients', v.c);
    assert not has_column_privilege('anon','public.repository_structure_analyses', v.c, 'update'), format('analyses: column %s is not updatable by anon', v.c);
    assert has_column_privilege('authenticated','public.repository_structure_analyses', v.c, 'insert') = (v.c in ('snapshot_id','status')),
      format('analyses: insert privilege on %s only for snapshot_id/status', v.c);
  end loop;
  assert (select count(*) from pg_policies where tablename = 'repository_structure_analyses' and cmd in ('UPDATE','ALL')) = 0, 'analyses: no UPDATE policy remains';
  assert has_table_privilege('authenticated','public.repository_structure_analyses','delete'), 'analyses: DELETE kept (policy-scoped)';
  -- private objects and the Vault are unreachable for clients
  assert not has_schema_privilege('authenticated','private','usage') and not has_schema_privilege('anon','private','usage'), 'private schema: no usage for clients';
  assert not has_table_privilege('authenticated','private.structure_analysis_runs','select') and not has_table_privilege('anon','private.structure_analysis_runs','select'), 'run-token table: no select for clients';
  assert not has_table_privilege('authenticated','private.structure_analysis_runs','insert') and not has_table_privilege('authenticated','private.structure_analysis_runs','update')
     and not has_table_privilege('authenticated','private.structure_analysis_runs','delete'), 'run-token table: no write for clients';
  assert not has_schema_privilege('authenticated','vault','usage') and not has_schema_privilege('anon','vault','usage'), 'vault schema: no usage for clients';
  assert not has_table_privilege('authenticated','vault.decrypted_secrets','select') and not has_table_privilege('authenticated','vault.secrets','select'), 'vault tables: no select for clients';
  assert not has_function_privilege('authenticated','private.structure_persist_key()','execute'), 'authenticated cannot execute the key reader';
  assert not has_function_privilege('authenticated','private.structure_hmac(text,text)','execute'), 'authenticated cannot execute the HMAC helper';
  assert not has_function_privilege('authenticated','private.structure_canonical(uuid,text,jsonb,jsonb,integer,integer,integer,integer)','execute'), 'authenticated cannot execute the canonicalizer';
  assert not has_function_privilege('anon','private.structure_persist_key()','execute'), 'anon cannot execute the key reader';
  assert (select relrowsecurity from pg_class where oid = 'private.structure_analysis_runs'::regclass), 'run-token table: RLS enabled (defense in depth)';
  -- functions
  assert (select prosecdef from pg_proc where oid = 'public.begin_structure_analysis(uuid)'::regprocedure), 'begin_structure_analysis is SECURITY DEFINER';
  assert (select prosecdef from pg_proc where oid = 'public.fail_structure_analysis(uuid,text)'::regprocedure), 'fail_structure_analysis is SECURITY DEFINER';
  assert (select prosecdef from pg_proc where oid = 'public.reset_structure_analysis(uuid)'::regprocedure), 'reset_structure_analysis is SECURITY DEFINER';
  assert (select prosecdef from pg_proc where oid = 'public.persist_structure_analysis(uuid,text,jsonb,jsonb,integer,integer,integer,integer,text)'::regprocedure), 'persist_structure_analysis is SECURITY DEFINER';
  assert (select count(*) from pg_proc where oid in (
      'public.begin_structure_analysis(uuid)'::regprocedure, 'public.fail_structure_analysis(uuid,text)'::regprocedure,
      'public.reset_structure_analysis(uuid)'::regprocedure,
      'public.persist_structure_analysis(uuid,text,jsonb,jsonb,integer,integer,integer,integer,text)'::regprocedure)
      and array_to_string(proconfig, ',') like '%search_path=""%') = 4, 'every definer function pins search_path to empty';
  assert not (select prosecdef from pg_proc where oid = 'public.create_structure_analysis(uuid)'::regprocedure), 'create_structure_analysis stays SECURITY INVOKER (RLS-checked insert)';
  assert to_regprocedure('public.persist_structure_analysis(uuid,jsonb,jsonb,integer,integer,integer,integer)') is null,
    'the old unsigned persist_structure_analysis signature no longer exists';
  for v in select f from unnest(array[
      'public.begin_structure_analysis(uuid)','public.fail_structure_analysis(uuid,text)','public.reset_structure_analysis(uuid)',
      'public.persist_structure_analysis(uuid,text,jsonb,jsonb,integer,integer,integer,integer,text)','public.create_structure_analysis(uuid)']) as f loop
    assert not has_function_privilege('anon', v.f, 'execute'), format('anon cannot execute %s', v.f);
    assert has_function_privilege('authenticated', v.f, 'execute'), format('authenticated can execute %s', v.f);
  end loop;

  ---------------------------------------------------------------- CROSS-IMPLEMENTATION VECTOR (Node signing.ts <-> database)
  -- GENERATED from src/server/repository-structure/signing.ts (Node): the database must reproduce it byte for byte.
  vec_key := $k$vector-key-0123456789-abcdefghijklmnop$k$;
  vec_canonical := replace($c$OFA-STRUCTURE-V1
00000000-0000-0000-0000-0000000000a1
abababababababababababababababababababababababababababababababab
7|3|2|2
3
2
S|00000000-0000-0000-0000-0000000000f1|CLASS|0|0|9|1|PUBLIC|3:Svc|7:pkg.Svc|9:class Svc
S|00000000-0000-0000-0000-0000000000f1|METHOD|1|2|3|3|UNKNOWN|5:a|b
c|-|-
S|00000000-0000-0000-0000-0000000000f2|FUNCTION|4|0|5|0|PRIVATE|16:naïve日本😀|9:é.日本|14:def f(é): ...
R|0|1|CONTAINS
R|2|2|CALLS
$c$, chr(13) || chr(10), chr(10));
  vec_sig := '6c4c5fed990d112cbad7e806bbd524bbceb3f784ca30c98af74a649d3d77a243';
  vec_symbols := $j$[{"kind":"CLASS","name":"Svc","file_id":"00000000-0000-0000-0000-0000000000f1","end_line":9,"signature":"class Svc","end_column":1,"start_line":0,"visibility":"PUBLIC","start_column":0,"qualified_name":"pkg.Svc"},{"kind":"METHOD","name":"a|b\nc","file_id":"00000000-0000-0000-0000-0000000000f1","end_line":3,"signature":null,"end_column":3,"start_line":1,"visibility":"UNKNOWN","start_column":2,"qualified_name":null},{"kind":"FUNCTION","name":"naïve日本😀","file_id":"00000000-0000-0000-0000-0000000000f2","end_line":5,"signature":"def f(é): ...","end_column":0,"start_line":4,"visibility":"PRIVATE","start_column":0,"qualified_name":"é.日本"}]$j$::jsonb;
  vec_rels := $j$[{"source_index":0,"target_index":1,"relationship_type":"CONTAINS"},{"source_index":2,"target_index":2,"relationship_type":"CALLS"}]$j$::jsonb;
  assert private.structure_canonical('00000000-0000-0000-0000-0000000000a1', repeat('ab', 32), vec_symbols, vec_rels, 7, 3, 2, 2) = vec_canonical,
    'database canonical message equals the Node canonical message byte for byte (incl. | newline and non-ASCII)';
  assert private.structure_hmac(vec_canonical, vec_key) = vec_sig, 'database HMAC-SHA256 equals the Node HMAC-SHA256';
  assert private.structure_hmac(vec_canonical, vec_key || 'x') <> vec_sig, 'a different key gives a different HMAC';
  assert private.structure_hmac(replace(vec_canonical, 'Svc', 'Svd'), vec_key) <> vec_sig, 'a changed message gives a different HMAC';

  ---------------------------------------------------------------- defaults (superuser insert, no values)
  insert into public.repository_structure_analyses (snapshot_id) values (s_val) returning * into r;
  assert r.status = 'PENDING' and r.started_at is null and r.completed_at is null and r.error_message is null, 'analysis defaults to PENDING with no timestamps';
  assert r.files_total = 0 and r.files_analyzed = 0 and r.files_unsupported = 0 and r.files_failed = 0
     and r.symbols_count = 0 and r.relationships_count = 0, 'analysis metrics default to 0';
  delete from public.repository_structure_analyses where id = r.id;

  ---------------------------------------------------------------- anonymous denied
  set local role anon;
  caught := false; begin perform count(*) from public.repository_structure_analyses; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read analyses';
  caught := false; begin perform count(*) from public.repository_symbols; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read symbols';
  caught := false; begin perform count(*) from public.repository_symbol_relationships; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read relationships';
  caught := false; begin perform public.create_structure_analysis(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not create analyses (RPC)';
  caught := false; begin perform public.begin_structure_analysis(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not begin analyses';
  caught := false; begin perform public.fail_structure_analysis(s_a, 'x'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not fail analyses';
  caught := false; begin perform public.reset_structure_analysis(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not reset analyses';
  caught := false; begin perform public.persist_structure_analysis(s_a, repeat('0',64), '[]'::jsonb, '[]'::jsonb, 0, 0, 0, 0, 'x'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not persist structure';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not insert analyses';
  reset role;

  ---------------------------------------------------------------- ANALYSIS: create by role, forged ids
  set local role authenticated;
  perform public.zz_as(owner1);
  select * into r from public.create_structure_analysis(s_a);
  an_a := r.id;
  assert r.status = 'PENDING' and r.snapshot_id = s_a, 'OWNER creates an analysis, always PENDING';
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.files_total = 0 and r.symbols_count = 0 and r.relationships_count = 0 and r.started_at is null, 'a new analysis has zeroed metrics and no timestamps';
  perform public.zz_as(admin1);
  select * into r from public.create_structure_analysis(s_b);
  an_b := r.id;
  assert r.snapshot_id = s_b, 'ADMIN creates an analysis for a repository of a team they are not in';

  perform public.zz_as(owner1);
  caught := false; begin perform public.create_structure_analysis(s_a); exception when unique_violation then caught := true; end;
  assert caught, 'a second analysis of the same snapshot is rejected (RPC)';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (s_a); exception when unique_violation then caught := true; end;
  assert caught, 'a second analysis of the same snapshot is rejected (direct INSERT)';
  insert into public.repository_structure_analyses (snapshot_id, status) values (s_a2, 'PENDING') returning id into an_a2;

  caught := false; begin perform public.create_structure_analysis(s_a_pend); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a PENDING snapshot cannot be analysed';
  caught := false; begin perform public.create_structure_analysis(s_a_fail); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a FAILED snapshot cannot be analysed';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (s_a_pend); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a PENDING snapshot cannot be analysed (direct INSERT)';
  for v in select st from unnest(array['PROCESSING','COMPLETED','FAILED']) as st loop
    caught := false;
    begin insert into public.repository_structure_analyses (snapshot_id, status) values (s_val, v.st); exception when insufficient_privilege then caught := true; end;
    assert caught, format('initial status forced to PENDING: direct insert as %s denied', v.st);
  end loop;
  for v in select c from unnest(array['files_total','files_analyzed','files_unsupported','files_failed','symbols_count','relationships_count']) as c loop
    caught := false;
    begin execute format('insert into public.repository_structure_analyses (snapshot_id, %I) values ($1, 7)', v.c) using s_val;
    exception when insufficient_privilege then caught := true; end;
    assert caught, format('metric %s cannot be supplied on insert', v.c);
  end loop;
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id, started_at) values (s_val, now()); exception when insufficient_privilege then caught := true; end;
  assert caught, 'started_at cannot be supplied on insert';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id, error_message) values (s_val, 'x'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'error_message cannot be supplied on insert';
  caught := false; begin insert into public.repository_structure_analyses (id, snapshot_id) values (gen_random_uuid(), s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'id cannot be supplied on insert';

  perform public.zz_as(ma);
  caught := false; begin perform public.create_structure_analysis(s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create analyses (RPC)';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create analyses (direct INSERT)';
  perform public.zz_as(mb);
  caught := false; begin perform public.create_structure_analysis(s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'cross-team: team B member must not create an analysis for team A snapshot';
  perform public.zz_as(owner2);
  caught := false; begin perform public.create_structure_analysis(s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged snapshot_id of another organization rejected (RPC)';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (s_val); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged snapshot_id of another organization rejected (direct INSERT)';
  caught := false; begin perform public.create_structure_analysis('00000000-0000-0000-0000-00000000ffff'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent snapshot_id rejected for clients';
  select * into r from public.create_structure_analysis(s_bb);
  an_bb := r.id;
  assert r.snapshot_id = s_bb, 'OWNER of org 2 creates an analysis for their own snapshot';
  reset role;

  ---------------------------------------------------------------- ANALYSIS: value validation (superuser; checks and FKs are role-independent)
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values (null); exception when not_null_violation then caught := true; end;
  assert caught, 'an analysis requires a snapshot';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id) values ('00000000-0000-0000-0000-00000000ffff'); exception when foreign_key_violation then caught := true; end;
  assert caught, 'an analysis must reference an existing snapshot (FK)';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id,status) values (s_val,'DONE'); exception when check_violation then caught := true; end;
  assert caught, 'invalid status rejected';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id,error_message) values (s_val, repeat('x',2001)); exception when check_violation then caught := true; end;
  assert caught, 'error_message over 2000 chars rejected';
  for v in select c from unnest(array['files_total','files_analyzed','files_unsupported','files_failed','symbols_count','relationships_count']) as c loop
    caught := false;
    begin
      if v.c = 'files_total' then
        insert into public.repository_structure_analyses (snapshot_id, files_total) values (s_val, -1);
      else
        execute format('insert into public.repository_structure_analyses (snapshot_id, files_total, %I) values ($1, 5, -1)', v.c) using s_val;
      end if;
    exception when check_violation then caught := true; end;
    assert caught, format('negative %s rejected', v.c);
  end loop;
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id,files_total,files_analyzed,files_unsupported,files_failed) values (s_val,3,2,1,1); exception when check_violation then caught := true; end;
  assert caught, 'analyzed + unsupported + failed over files_total rejected';
  insert into public.repository_structure_analyses (snapshot_id,files_total,files_analyzed,files_unsupported,files_failed) values (s_val,4,2,1,1);
  delete from public.repository_structure_analyses where snapshot_id = s_val;
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id,status) values (s_val,'COMPLETED'); exception when check_violation then caught := true; end;
  assert caught, 'a COMPLETED analysis must have completed_at';
  caught := false; begin insert into public.repository_structure_analyses (snapshot_id,status,started_at,completed_at) values (s_val,'FAILED',now(),now() - interval '1 hour'); exception when check_violation then caught := true; end;
  assert caught, 'completed_at before started_at rejected';

  ---------------------------------------------------------------- ANALYSIS: visibility (parent-derived)
  set local role authenticated;
  perform public.zz_as(owner1);
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_a2,an_b); assert n = 3, 'OWNER sees analyses of all org 1 snapshots';
  select count(*) into n from public.repository_structure_analyses where id = an_bb; assert n = 0, 'OWNER cannot see org 2 analysis';
  perform public.zz_as(admin1);
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_a2,an_b); assert n = 3, 'ADMIN sees all org 1 analyses, even in no team';
  perform public.zz_as(ma);
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_a2); assert n = 2, 'team A MEMBER can view their analyses (read-only)';
  select count(*) into n from public.repository_structure_analyses where id = an_b; assert n = 0, 'cross-team: team A member cannot see team B analysis';
  select count(*) into n from public.repository_structure_analyses where id = an_bb; assert n = 0, 'cross-organization: org 1 member cannot see org 2 analysis';
  perform public.zz_as(mb);
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_a2); assert n = 0, 'team B member cannot see team A analyses (same department)';
  select count(*) into n from public.repository_structure_analyses where id = an_b; assert n = 1, 'team B member sees own analysis';
  perform public.zz_as(mdept);
  select count(*) into n from public.repository_structure_analyses; assert n = 0, 'same-department user with no team sees no analyses';
  perform public.zz_as(mx);
  select count(*) into n from public.repository_structure_analyses; assert n = 0, 'non-team org member sees no analyses';
  perform public.zz_as(mo);
  select count(*) into n from public.repository_structure_analyses; assert n = 0, 'other-department user sees no analyses';
  perform public.zz_as(owner2);
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_a2,an_b); assert n = 0, 'other organization sees no org 1 analyses';
  select count(*) into n from public.repository_structure_analyses; assert n = 1, 'org 2 owner sees only org 2 analyses';
  perform public.zz_as(m2);
  select count(*) into n from public.repository_structure_analyses where id = an_bb; assert n = 1, 'org 2 team member sees own analysis';
  select count(*) into n from public.repository_structure_analyses where id in (an_a,an_b); assert n = 0, 'org 2 member sees no org 1 analyses';
  reset role;

  ---------------------------------------------------------------- DIRECT-ATTACK DENIALS: lifecycle UPDATE (every role, every column)
  set local role authenticated;
  for v in select u from unnest(array[owner1, admin1, ma, mb, owner2]) as u loop
    perform public.zz_as(v.u);
    for r in select c, val from (values
        ('status', $q$'PROCESSING'$q$), ('status', $q$'COMPLETED'$q$), ('status', $q$'FAILED'$q$), ('started_at','now()'), ('completed_at','now()'),
        ('error_message', $q$'forged'$q$), ('files_total','1'), ('files_analyzed','1'), ('files_unsupported','1'), ('files_failed','1'),
        ('symbols_count','1'), ('relationships_count','1'), ('snapshot_id', quote_literal(s_bb)), ('id','gen_random_uuid()'), ('created_at','now()')) as t(c, val) loop
      caught := false;
      begin execute format('update public.repository_structure_analyses set %I = %s where id = $1', r.c, r.val) using an_a;
      exception when insufficient_privilege then caught := true; end;
      assert caught, format('direct UPDATE of %s denied for user %s', r.c, v.u);
    end loop;
  end loop;
  perform public.zz_as(owner1);
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now(), files_total = 3, files_unsupported = 3 where id = an_a;
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'a forged COMPLETED analysis (status + metrics) cannot be written directly';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PENDING' and r.completed_at is null and r.files_total = 0, 'the analysis is untouched by every denied UPDATE';

  ---------------------------------------------------------------- LIFECYCLE FUNCTIONS: authorization
  -- (reset needs a FAILED analysis and persist a PROCESSING one to be meaningful: both are tested in those states below)
  set local role authenticated;
  for v in select u, l from (values (ma,'team MEMBER'),(mb,'cross-team MEMBER'),(mdept,'same-dept no-team'),(mx,'org member no team'),(mo,'other dept'),(owner2,'OTHER-ORG OWNER'),(m2,'other-org member')) as t(u, l) loop
    perform public.zz_as(v.u);
    caught := false; begin perform public.begin_structure_analysis(an_a); exception when others then caught := (sqlstate = '42501' and sqlerrm = 'Analysis not found'); end;
    assert caught, format('%s must not begin an analysis', v.l);
    caught := false; begin perform public.fail_structure_analysis(an_a, 'x'); exception when others then caught := (sqlstate = '42501' and sqlerrm = 'Analysis not found'); end;
    assert caught, format('%s must not fail an analysis', v.l);
  end loop;
  perform public.zz_as(owner2);
  caught := false; begin perform public.begin_structure_analysis('00000000-0000-0000-0000-00000000ffff'); exception when others then caught := (sqlstate = '42501' and sqlerrm = 'Analysis not found'); end;
  assert caught, 'begin on a nonexistent analysis is indistinguishable from unauthorized';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PENDING' and not exists (select 1 from private.structure_analysis_runs), 'denied lifecycle calls changed nothing and issued no token';

  ---------------------------------------------------------------- LIFECYCLE FUNCTIONS: behaviour
  set local role authenticated;
  perform public.zz_as(owner1);
  caught := false; begin perform public.reset_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'reset on a PENDING analysis rejected (only FAILED can be reset)';
  select * into r from public.fail_structure_analysis(an_a, '  boom  ');
  assert r.status = 'FAILED', 'PENDING -> FAILED';
  for v in select u, l from (values (ma,'team MEMBER'),(mb,'cross-team MEMBER'),(mdept,'same-dept no-team'),(mx,'org member no team'),(mo,'other dept'),(owner2,'OTHER-ORG OWNER'),(m2,'other-org member')) as t(u, l) loop
    perform public.zz_as(v.u);
    caught := false; begin perform public.reset_structure_analysis(an_a); exception when others then caught := (sqlstate = '42501' and sqlerrm = 'Analysis not found'); end;
    assert caught, format('%s must not reset a FAILED analysis', v.l);
  end loop;
  perform public.zz_as(owner1);
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'FAILED' and r.error_message = 'boom' and r.completed_at is not null and r.started_at is null, 'failure recorded (trimmed message, completed_at set)';
  assert not exists (select 1 from private.structure_analysis_runs where analysis_id = an_a), 'a FAILED analysis has no run token';
  set local role authenticated; perform public.zz_as(owner1);
  caught := false; begin perform public.fail_structure_analysis(an_a, 'again'); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'FAILED -> FAILED rejected';
  caught := false; begin perform public.begin_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'FAILED -> PROCESSING rejected (must be reset first)';
  select * into r from public.reset_structure_analysis(an_a);
  assert r.status = 'PENDING', 'FAILED -> PENDING (retry)';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PENDING' and r.error_message is null and r.completed_at is null and r.started_at is null and r.files_total = 0 and r.symbols_count = 0, 'a retried analysis is clean';
  set local role authenticated; perform public.zz_as(owner1);
  select * into r from public.begin_structure_analysis(an_a);
  tok_old := r.run_token;
  assert r.analysis_id = an_a and tok_old ~ '^[0-9a-f]{64}$', 'begin returns a 64-hex run token';
  caught := false; begin perform public.begin_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'begin on a PROCESSING analysis rejected (no second run)';
  caught := false; begin perform public.reset_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'reset on a PROCESSING analysis rejected';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PROCESSING' and r.started_at is not null and r.completed_at is null and r.error_message is null and r.files_total = 0, 'PROCESSING with started_at set and clean metrics';
  assert (select run_token from private.structure_analysis_runs where analysis_id = an_a) = tok_old, 'the token is stored privately for this run';
  set local role authenticated; perform public.zz_as(owner1);
  caught := false; begin perform count(*) from private.structure_analysis_runs; exception when insufficient_privilege then caught := true; end;
  assert caught, 'clients cannot read run tokens';
  caught := false; begin perform vault.create_secret('x','probe'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'clients cannot use the vault';
  caught := false; begin perform count(*) from vault.decrypted_secrets; exception when insufficient_privilege then caught := true; end;
  assert caught, 'clients cannot read decrypted vault secrets';
  caught := false; begin perform private.structure_persist_key(); exception when insufficient_privilege then caught := true; end;
  assert caught, 'clients cannot call the key reader';
  select * into r from public.fail_structure_analysis(an_a, 'interrupted');
  select * into r from public.reset_structure_analysis(an_a);
  select * into r from public.begin_structure_analysis(an_a);
  tok_new := r.run_token;
  assert tok_new <> tok_old and tok_new ~ '^[0-9a-f]{64}$', 'a retry issues a fresh run token';
  tok_a := tok_new;
  perform public.zz_as(admin1);
  select * into r from public.begin_structure_analysis(an_a2);
  tok_a2 := r.run_token;
  assert tok_a2 <> tok_a, 'tokens differ between analyses';
  reset role;

  ---------------------------------------------------------------- SIGNED PERSISTENCE (an_a PROCESSING, token tok_a; an_a2 PROCESSING, token tok_a2)
  base_syms := jsonb_build_array(
    public.zz_sym(f_a1, 'Svc', 'CLASS', 'Svc', 'class Svc', 0, 0, 9, 1, 'PUBLIC'),
    public.zz_sym(f_a1, 'run', 'METHOD', 'Svc.run', 'run(): void', 1, 2, 3, 3, 'PUBLIC'),
    public.zz_sym(f_a2, 'helper', 'FUNCTION', null, null, 0, 0, 2, 0, 'UNKNOWN'));
  base_rels := jsonb_build_array(jsonb_build_object('source_index', 0, 'target_index', 1, 'relationship_type', 'CONTAINS'));
  sig := public.zz_sig(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0);

  set local role authenticated;
  perform public.zz_as(owner1);

  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a, tok_old, base_syms, base_rels, 3, 2, 1, 0, public.zz_sig(an_a, tok_old, base_syms, base_rels, 3, 2, 1, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid run token', 'the pre-retry run token is rejected even with a signature valid for it; got ' || coalesce(msg, 'no error');
  tok_x := encode(extensions.gen_random_bytes(32), 'hex');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a, tok_x, base_syms, base_rels, 3, 2, 1, 0, public.zz_sig(an_a, tok_x, base_syms, base_rels, 3, 2, 1, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid run token', 'a wrong run token is rejected by the token check; got ' || coalesce(msg, 'no error');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, public.zz_sig(an_a, tok_x, base_syms, base_rels, 3, 2, 1, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid structure signature', 'the run token is part of the signed message; got ' || coalesce(msg, 'no error');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a2, tok_a, '[]'::jsonb, '[]'::jsonb, 1, 0, 1, 0, public.zz_sig(an_a2, tok_a, '[]'::jsonb, '[]'::jsonb, 1, 0, 1, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid run token', 'the token of analysis A is rejected for analysis B; got ' || coalesce(msg, 'no error');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a2, tok_a2, base_syms, base_rels, 3, 2, 1, 0, sig);
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid structure signature', 'a signature made for analysis A is rejected on analysis B; got ' || coalesce(msg, 'no error');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a2, tok_a2, base_syms, base_rels, 3, 2, 1, 0, public.zz_sig(an_a, tok_a2, base_syms, base_rels, 3, 2, 1, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid structure signature', 'the analysis id is part of the signed message; got ' || coalesce(msg, 'no error');
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, public.zz_sig(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, other_key));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid structure signature', 'a signature made with the wrong key is rejected; got ' || coalesce(msg, 'no error');
  for v in select s from unnest(array['', 'x', repeat('0', 64), left(sig, 63), sig || '0', upper(sig)]) as s loop
    caught := false; msg := null;
    begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, v.s);
    exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
    assert caught and msg = 'Invalid structure signature', format('malformed signature rejected: [%s]', left(v.s, 20));
  end loop;
  caught := false;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, null); exception when invalid_parameter_value then caught := true; end;
  assert caught, 'a NULL signature is rejected';
  caught := false;
  begin perform public.persist_structure_analysis(an_a, null, base_syms, base_rels, 3, 2, 1, 0, sig); exception when invalid_parameter_value then caught := true; end;
  assert caught, 'a NULL run token is rejected';

  -- field-boundary ambiguity: two DIFFERENT payloads must never share one canonical message
  -- ("a" + "b|c" and "a|b" + "c" would both read "a|b|c" without length prefixes)
  declare s_b1 jsonb; s_b2 jsonb; s_b3 jsonb; sg text; begin
    s_b1 := jsonb_build_array(public.zz_sym(f_a1, 'a', 'CLASS', 'b|c'));
    s_b2 := jsonb_build_array(public.zz_sym(f_a1, 'a|b', 'CLASS', 'c'));
    sg := public.zz_sig(an_a, tok_a, s_b1, '[]'::jsonb, 3, 2, 1, 0);
    caught := false; msg := null;
    begin perform public.persist_structure_analysis(an_a, tok_a, s_b2, '[]'::jsonb, 3, 2, 1, 0, sg);
    exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
    assert caught and msg = 'Invalid structure signature', 'a field-boundary shift (name | qualified_name) does not reuse a signature; got ' || coalesce(msg, 'no error');
    -- the same with a newline: a value that tries to smuggle a whole extra symbol line
    s_b1 := jsonb_build_array(public.zz_sym(f_a1, E'x\nS|' || f_a2::text || '|CLASS|0|0|1|0|UNKNOWN|1:y|-|-', 'CLASS'));
    s_b2 := jsonb_build_array(public.zz_sym(f_a1, 'x', 'CLASS'), public.zz_sym(f_a2, 'y', 'CLASS'));
    sg := public.zz_sig(an_a, tok_a, s_b1, '[]'::jsonb, 3, 2, 1, 0);
    caught := false; msg := null;
    begin perform public.persist_structure_analysis(an_a, tok_a, s_b2, '[]'::jsonb, 3, 2, 1, 0, sg);
    exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
    assert caught and msg = 'Invalid structure signature', 'a value smuggling a second symbol line does not reuse a signature; got ' || coalesce(msg, 'no error');
  end;

  -- every single aspect of the payload is covered by the signature: sign the base payload, submit a one-field change
  for v in select lbl, syms, rels, ft, fa, fu, ff from (values
      ('symbol name',               jsonb_set(base_syms, '{0,name}', '"Svd"'), base_rels, 3, 2, 1, 0),
      ('symbol kind',               jsonb_set(base_syms, '{0,kind}', '"INTERFACE"'), base_rels, 3, 2, 1, 0),
      ('symbol file_id',            jsonb_set(base_syms, '{2,file_id}', to_jsonb(f_a3::text)), base_rels, 3, 2, 1, 0),
      ('symbol qualified_name',     jsonb_set(base_syms, '{0,qualified_name}', '"Other"'), base_rels, 3, 2, 1, 0),
      ('symbol qualified_name null->value', jsonb_set(base_syms, '{2,qualified_name}', '"x"'), base_rels, 3, 2, 1, 0),
      ('symbol qualified_name value->null', jsonb_set(base_syms, '{0,qualified_name}', 'null'), base_rels, 3, 2, 1, 0),
      ('symbol signature',          jsonb_set(base_syms, '{0,signature}', '"class Other"'), base_rels, 3, 2, 1, 0),
      ('symbol signature null->value', jsonb_set(base_syms, '{2,signature}', '"x"'), base_rels, 3, 2, 1, 0),
      ('symbol start_line',         jsonb_set(base_syms, '{1,start_line}', '2'), base_rels, 3, 2, 1, 0),
      ('symbol start_column',       jsonb_set(base_syms, '{1,start_column}', '3'), base_rels, 3, 2, 1, 0),
      ('symbol end_line',           jsonb_set(base_syms, '{1,end_line}', '4'), base_rels, 3, 2, 1, 0),
      ('symbol end_column',         jsonb_set(base_syms, '{1,end_column}', '4'), base_rels, 3, 2, 1, 0),
      ('symbol visibility',         jsonb_set(base_syms, '{0,visibility}', '"PRIVATE"'), base_rels, 3, 2, 1, 0),
      ('symbol order (swap 0/1)',   jsonb_build_array(base_syms -> 1, base_syms -> 0, base_syms -> 2), base_rels, 3, 2, 1, 0),
      ('symbol removed',            base_syms - 2, base_rels, 3, 2, 1, 0),
      ('symbol added',              base_syms || jsonb_build_array(public.zz_sym(f_a3, 'extra')), base_rels, 3, 2, 1, 0),
      ('relationship source_index', base_syms, jsonb_set(base_rels, '{0,source_index}', '2'), 3, 2, 1, 0),
      ('relationship target_index', base_syms, jsonb_set(base_rels, '{0,target_index}', '2'), 3, 2, 1, 0),
      ('relationship type',         base_syms, jsonb_set(base_rels, '{0,relationship_type}', '"REFERENCES"'), 3, 2, 1, 0),
      ('relationship removed',      base_syms, '[]'::jsonb, 3, 2, 1, 0),
      ('relationship added',        base_syms, base_rels || jsonb_build_array(jsonb_build_object('source_index', 0, 'target_index', 2, 'relationship_type', 'IMPORTS')), 3, 2, 1, 0),
      ('files_total',               base_syms, base_rels, 4, 2, 1, 0),
      ('files_analyzed',            base_syms, base_rels, 3, 3, 1, 0),
      ('files_unsupported',         base_syms, base_rels, 3, 2, 2, 0),
      ('files_failed',              base_syms, base_rels, 3, 2, 1, 1),
      ('file counts moved (same sum)', base_syms, base_rels, 3, 1, 2, 0)) as t(lbl, syms, rels, ft, fa, fu, ff) loop
    caught := false; msg := null;
    begin perform public.persist_structure_analysis(an_a, tok_a, v.syms, v.rels, v.ft, v.fa, v.fu, v.ff, sig);
    exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
    assert caught and msg = 'Invalid structure signature', format('a changed %s invalidates the signature; got %s', v.lbl, coalesce(msg, 'no error'));
  end loop;
  for v in select u, l from (values (ma,'team MEMBER'),(mb,'cross-team MEMBER'),(mdept,'same-dept no-team'),(mx,'org member no team'),(mo,'other dept'),(owner2,'OTHER-ORG OWNER'),(m2,'other-org member')) as t(u, l) loop
    perform public.zz_as(v.u);
    caught := false; msg := null;
    begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig);
    exception when others then caught := (sqlstate = '42501' and sqlerrm = 'Analysis not found'); msg := sqlerrm; end;
    assert caught, format('%s cannot persist even with a perfectly valid token and signature; got %s', v.l, coalesce(msg, 'no error'));
  end loop;
  perform public.zz_as(owner1);
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PROCESSING' and r.symbols_count = 0 and not exists (select 1 from public.repository_symbols where analysis_id = an_a), 'no rejected attempt changed or wrote anything';
  assert (select run_token from private.structure_analysis_runs where analysis_id = an_a) = tok_a, 'rejected attempts did not consume the token';

  -- validly signed but INVALID payloads: rejected atomically (a signature is not a licence to write bad data)
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a,f_a1,'Leftover','CLASS',0,0,1,0);
  set local role authenticated; perform public.zz_as(owner1);
  for v in select lbl, syms, rels, ft, fa, fu, ff, st from (values
      ('invalid kind', jsonb_set(base_syms, '{0,kind}', '"NOT_A_KIND"'), base_rels, 3, 2, 1, 0, 'check_violation'),
      ('file of another snapshot (same repository)', jsonb_set(base_syms, '{0,file_id}', to_jsonb(f_a2_1::text)), base_rels, 3, 2, 1, 0, 'check_violation'),
      ('file of another organization', jsonb_set(base_syms, '{0,file_id}', to_jsonb(f_bb::text)), base_rels, 3, 2, 1, 0, 'check_violation'),
      ('relationship pointing outside the batch', base_syms, jsonb_build_array(jsonb_build_object('source_index', 0, 'target_index', 99, 'relationship_type', 'CONTAINS')), 3, 2, 1, 0, 'check_violation'),
      ('self-EXTENDS relationship', base_syms, jsonb_build_array(jsonb_build_object('source_index', 0, 'target_index', 0, 'relationship_type', 'EXTENDS')), 3, 2, 1, 0, 'check_violation'),
      ('duplicate symbol', base_syms || jsonb_build_array(base_syms -> 0), base_rels, 4, 3, 1, 0, 'unique_violation'),
      ('files_total not matching the manifest', base_syms, base_rels, 9, 2, 1, 6, 'check_violation'),
      ('file counts not adding up', base_syms, base_rels, 3, 3, 3, 3, 'check_violation'),
      ('end before start', jsonb_set(base_syms, '{0,end_line}', '-1'), base_rels, 3, 2, 1, 0, 'check_violation')) as t(lbl, syms, rels, ft, fa, fu, ff, st) loop
    caught := false; msg := null;
    begin
      perform public.persist_structure_analysis(an_a, tok_a, v.syms, v.rels, v.ft, v.fa, v.fu, v.ff, public.zz_sig(an_a, tok_a, v.syms, v.rels, v.ft, v.fa, v.fu, v.ff));
    exception
      when check_violation then caught := (v.st = 'check_violation'); msg := sqlerrm;
      when unique_violation then caught := (v.st = 'unique_violation'); msg := sqlerrm;
      when not_null_violation then caught := (v.st = 'check_violation'); msg := sqlerrm;
    end;
    assert caught, format('a validly signed but invalid payload (%s) is rejected; got %s', v.lbl, coalesce(msg, 'no error'));
  end loop;
  caught := false;
  begin perform public.persist_structure_analysis(an_a, tok_a, '{"a":1}'::jsonb, '[]'::jsonb, 3, 0, 3, 0, 'x'); exception when invalid_parameter_value then caught := true; end;
  assert caught, 'a non-array symbols payload is rejected';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'PROCESSING' and r.completed_at is null, 'invalid payloads left the analysis PROCESSING';
  assert (select count(*) from public.repository_symbols where analysis_id = an_a) = 1 and exists (select 1 from public.repository_symbols where analysis_id = an_a and name = 'Leftover'),
    'invalid payloads rolled back completely: the previous structure is intact';
  assert (select run_token from private.structure_analysis_runs where analysis_id = an_a) = tok_a, 'a rolled-back attempt does not consume the token';

  -- a missing / short Vault key refuses everything
  delete from vault.secrets where name = 'structure_persist_key';
  set local role authenticated; perform public.zz_as(owner1);
  caught := false;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'persist is refused when no key is configured in the Vault';
  reset role;
  perform vault.create_secret('short', 'structure_persist_key', 'too short');
  set local role authenticated; perform public.zz_as(owner1);
  caught := false;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'persist is refused when the Vault key is shorter than 32 characters';
  reset role;
  delete from vault.secrets where name = 'structure_persist_key';
  perform vault.create_secret(test_key, 'structure_persist_key', 'phase 2h test key');

  -- VALID, server-signed persistence (also a rebuild: the leftover row is replaced, never appended to)
  set local role authenticated; perform public.zz_as(owner1);
  begin
    select * into r from public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig);
  exception when others then assert false, 'a valid server-signed persistence must succeed, got ' || sqlstate || ' ' || sqlerrm; end;
  assert r.status = 'COMPLETED' and r.symbols_count = 3 and r.relationships_count = 1, 'persist returns COMPLETED with the real counts';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'COMPLETED' and r.completed_at is not null and r.error_message is null, 'persist completes the analysis';
  assert r.files_total = 3 and r.files_analyzed = 2 and r.files_unsupported = 1 and r.files_failed = 0 and r.symbols_count = 3 and r.relationships_count = 1, 'persist records the file metrics and real counts';
  assert (select count(*) from public.repository_symbols where analysis_id = an_a) = 3 and not exists (select 1 from public.repository_symbols where name = 'Leftover'), 'the leftover symbol was replaced by exactly the new 3';
  assert (select count(*) from public.repository_symbol_relationships rr
            join public.repository_symbols a on a.id = rr.source_symbol_id join public.repository_symbols b on b.id = rr.target_symbol_id
            where rr.analysis_id = an_a and a.name = 'Svc' and b.name = 'run' and rr.relationship_type = 'CONTAINS') = 1, 'the relationship points at the new Svc -> run symbols';
  assert not exists (select 1 from private.structure_analysis_runs where analysis_id = an_a), 'the run token is consumed by a successful persist';
  assert (select qualified_name is null and signature is null from public.repository_symbols where analysis_id = an_a and name = 'helper'), 'NULL qualified_name/signature are stored as NULL';
  select id into sy_svc from public.repository_symbols where analysis_id = an_a and name = 'Svc';
  select id into sy_helper from public.repository_symbols where analysis_id = an_a and name = 'helper';

  -- REPLAY: the very same signed request after COMPLETED
  set local role authenticated; perform public.zz_as(owner1);
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig);
  exception when others then caught := (sqlstate = '55000'); msg := sqlerrm; end;
  assert caught, 'replaying the signed request after COMPLETED is rejected; got ' || coalesce(msg, 'no error');
  perform public.zz_as(admin1);
  caught := false;
  begin perform public.persist_structure_analysis(an_a, tok_a, base_syms, base_rels, 3, 2, 1, 0, sig); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'replay is rejected for ADMIN too';
  caught := false; begin perform public.begin_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'a COMPLETED analysis cannot begin again';
  caught := false; begin perform public.fail_structure_analysis(an_a, 'x'); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'a COMPLETED analysis cannot be failed';
  caught := false; begin perform public.reset_structure_analysis(an_a); exception when others then caught := (sqlstate = '55000'); end;
  assert caught, 'a COMPLETED analysis cannot be reset';
  reset role;
  assert (select count(*) from public.repository_symbols where analysis_id = an_a) = 3, 'the replay and lifecycle attempts did not touch the structure';
  select * into r from public.repository_structure_analyses where id = an_a2;
  assert r.status = 'PROCESSING', 'analysis B is still PROCESSING after all attempts with A''s material';

  ---------------------------------------------------------------- DIRECT-ATTACK DENIALS: structure writes (an_a2 is PROCESSING: the generation window is open)
  set local role authenticated;
  for v in select u, l from (values (owner1,'OWNER'),(admin1,'ADMIN'),(ma,'MEMBER'),(owner2,'other-org OWNER')) as t(u, l) loop
    perform public.zz_as(v.u);
    caught := false;
    begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Forged','CLASS',0,0,1,0);
    exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot insert a symbol, even while the analysis is PROCESSING', v.l);
    caught := false;
    begin insert into public.repository_symbols (id,analysis_id,file_id,name,kind,qualified_name,signature,start_line,start_column,end_line,end_column,visibility)
      values (gen_random_uuid(),an_a2,f_a2_1,'Forged','CLASS','q','s',0,0,1,0,'PUBLIC');
    exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot insert a fully specified symbol', v.l);
    caught := false;
    begin delete from public.repository_symbols where analysis_id = an_a; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot delete symbols (COMPLETED analysis)', v.l);
    caught := false;
    begin delete from public.repository_symbols where analysis_id = an_a2; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot delete symbols (PROCESSING analysis)', v.l);
    caught := false;
    begin update public.repository_symbols set name = 'x' where analysis_id = an_a; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot update symbols', v.l);
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a, sy_svc, sy_helper, 'CALLS');
    exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot insert a relationship', v.l);
    caught := false;
    begin delete from public.repository_symbol_relationships where analysis_id = an_a; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot delete relationships', v.l);
    caught := false;
    begin update public.repository_symbol_relationships set relationship_type = 'CALLS' where analysis_id = an_a; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot update relationships', v.l);
    caught := false;
    begin truncate public.repository_symbols; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot TRUNCATE symbols', v.l);
    caught := false;
    begin truncate public.repository_symbol_relationships; exception when insufficient_privilege then caught := true; end;
    assert caught, format('%s cannot TRUNCATE relationships', v.l);
  end loop;
  reset role;
  assert (select count(*) from public.repository_symbols where analysis_id = an_a) = 3 and (select count(*) from public.repository_symbol_relationships where analysis_id = an_a) = 1,
    'every denied write left the completed structure exactly as persisted';

  ---------------------------------------------------------------- READ visibility of structure follows the analysis (an_a COMPLETED: 3 symbols, 1 relationship)
  set local role authenticated;
  perform public.zz_as(owner1);
  select count(*) into n from public.repository_symbols where analysis_id = an_a; assert n = 3, 'OWNER reads symbols';
  perform public.zz_as(ma);
  select count(*) into n from public.repository_symbols where analysis_id = an_a; assert n = 3, 'team A MEMBER reads symbols of their analysis';
  select count(*) into n from public.repository_symbol_relationships where analysis_id = an_a; assert n = 1, 'team A MEMBER reads relationships of their analysis';
  perform public.zz_as(mb);
  select count(*) into n from public.repository_symbols where analysis_id = an_a; assert n = 0, 'cross-team member sees no team A symbols';
  select count(*) into n from public.repository_symbol_relationships where analysis_id = an_a; assert n = 0, 'cross-team member sees no relationships';
  perform public.zz_as(mx);
  select count(*) into n from public.repository_symbols; assert n = 0, 'non-team member sees no symbols';
  perform public.zz_as(owner2);
  select count(*) into n from public.repository_symbols; assert n = 0, 'other organization sees no org 1 symbols';
  select count(*) into n from public.repository_symbol_relationships; assert n = 0, 'other organization sees no org 1 relationships';
  reset role;

  ---------------------------------------------------------------- COMPLETED IS SEALED IN THE DATABASE (even for superuser / definer paths)
  for v in select c, val from (values
      ('status', $q$'FAILED'$q$), ('status', $q$'PENDING'$q$), ('status', $q$'PROCESSING'$q$), ('status', $q$'COMPLETED'$q$),
      ('started_at','now()'), ('completed_at','now()'), ('error_message', $q$'tampered'$q$), ('files_total','99'), ('files_analyzed','0'),
      ('files_unsupported','0'), ('files_failed','0'), ('symbols_count','99'), ('relationships_count','99'), ('snapshot_id', quote_literal(s_val)),
      ('created_at', 'now()')) as t(c, val) loop
    caught := false;
    begin execute format('update public.repository_structure_analyses set %I = %s where id = $1', v.c, v.val) using an_a;
    exception when check_violation then caught := true; end;
    assert caught, format('COMPLETED analysis: UPDATE of %s rejected by the database trigger (RLS bypassed)', v.c);
  end loop;
  caught := false;
  begin update public.repository_structure_analyses set status = status where id = an_a; exception when check_violation then caught := true; end;
  assert caught, 'even a no-op UPDATE of a COMPLETED analysis is rejected';
  caught := false;
  begin update public.repository_structure_analyses set symbols_count = 0, error_message = 'x', started_at = null where id = an_a; exception when check_violation then caught := true; end;
  assert caught, 'a multi-column UPDATE of a COMPLETED analysis is rejected';
  -- structure write window (superuser inserts are still subject to the trigger)
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a,f_a1,'Late','CLASS',9,0,10,0); exception when check_violation then caught := true; end;
  assert caught, 'no symbol can be inserted into a COMPLETED analysis (write-window trigger)';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_b,f_b,'EarlyB','CLASS',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'no symbol can be inserted into a PENDING analysis (write-window trigger)';
  update public.repository_structure_analyses set status = 'FAILED', completed_at = now(), error_message = 'x' where id = an_b;
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_b,f_b,'EarlyB','CLASS',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'no symbol can be inserted into a FAILED analysis (write-window trigger)';
  update public.repository_structure_analyses set status = 'PENDING', completed_at = null, error_message = null where id = an_b;
  caught := false;
  begin update public.repository_symbols set name = 'renamed' where analysis_id = an_a; exception when check_violation then caught := true; end;
  assert caught, 'a symbol cannot be UPDATEd, even by superuser (immutable generated structure)';
  caught := false;
  begin update public.repository_symbol_relationships set relationship_type = 'CALLS' where analysis_id = an_a; exception when check_violation then caught := true; end;
  assert caught, 'a relationship cannot be UPDATEd, even by superuser';
  -- a run token row can only exist for a PROCESSING analysis
  caught := false;
  begin insert into private.structure_analysis_runs (analysis_id, run_token) values (an_a, repeat('0', 64)); exception when check_violation then caught := true; end;
  assert caught, 'no run token can be created for a COMPLETED analysis';
  caught := false;
  begin insert into private.structure_analysis_runs (analysis_id, run_token) values (an_b, repeat('0', 64)); exception when check_violation then caught := true; end;
  assert caught, 'no run token can be created for a PENDING analysis';
  select * into r from public.repository_structure_analyses where id = an_a;
  assert r.status = 'COMPLETED' and r.files_total = 3 and r.symbols_count = 3, 'the sealed analysis is exactly as completed';

  ---------------------------------------------------------------- Transition rules and completion integrity (superuser: triggers are role-independent)
  insert into public.repository_structure_analyses (snapshot_id) values (s_val) returning id into an_v;
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now() where id = an_v; exception when check_violation then caught := true; end;
  assert caught, 'PENDING -> COMPLETED rejected by the lifecycle rule itself (consistent metrics)';
  update public.repository_structure_analyses set status = 'FAILED', completed_at = now(), error_message = 'x' where id = an_v;
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED' where id = an_v; exception when check_violation then caught := true; end;
  assert caught, 'FAILED -> COMPLETED rejected by the lifecycle rule itself (consistent metrics)';
  caught := false;
  begin update public.repository_structure_analyses set status = 'PROCESSING' where id = an_v; exception when check_violation then caught := true; end;
  assert caught, 'FAILED -> PROCESSING rejected (must go through PENDING)';
  update public.repository_structure_analyses set status = 'PENDING', completed_at = null, error_message = null where id = an_v;
  update public.repository_structure_analyses set status = 'PROCESSING', started_at = now() where id = an_v;
  caught := false;
  begin update public.repository_structure_analyses set status = 'PENDING' where id = an_v; exception when check_violation then caught := true; end;
  assert caught, 'PROCESSING -> PENDING rejected';
  begin
    update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now() where id = an_v;
  exception when others then assert false, 'PROCESSING -> COMPLETED with consistent (empty) metrics must succeed, got ' || sqlstate; end;
  delete from public.repository_structure_analyses where id = an_v;
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now(), files_total = 1, files_analyzed = 1, symbols_count = 5 where id = an_a2; exception when check_violation then caught := true; end;
  assert caught, 'completion with a forged symbols_count rejected';
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now(), files_total = 1, files_analyzed = 1, relationships_count = 9 where id = an_a2; exception when check_violation then caught := true; end;
  assert caught, 'completion with a forged relationships_count rejected';
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now(), files_total = 7, files_analyzed = 7 where id = an_a2; exception when check_violation then caught := true; end;
  assert caught, 'completion with files_total different from the manifest rejected';
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', completed_at = now(), files_total = 1, files_analyzed = 0 where id = an_a2; exception when check_violation then caught := true; end;
  assert caught, 'completion whose file counts do not account for every file rejected';
  caught := false;
  begin update public.repository_structure_analyses set status = 'COMPLETED', files_total = 1, files_analyzed = 1 where id = an_a2; exception when check_violation then caught := true; end;
  assert caught, 'completion without completed_at rejected';
  select * into r from public.repository_structure_analyses where id = an_a2;
  assert r.status = 'PROCESSING', 'rejected completions left the analysis PROCESSING';

  ---------------------------------------------------------------- STRUCTURE constraints and isolation (superuser inserts inside the PROCESSING window of an_a2)
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Other','CLASS',0,0,1,0);
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a1,'X','CLASS',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'snapshot isolation: file of another snapshot (same repository) rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_b,'X','CLASS',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'snapshot isolation: file of another repository rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_bb,'X','CLASS',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'snapshot isolation: file of another organization rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,'00000000-0000-0000-0000-00000000ffff','X','CLASS',0,0,1,0); exception when check_violation or foreign_key_violation then caught := true; end;
  assert caught, 'snapshot isolation: nonexistent file rejected';
  for v in select k from unnest(array['class','Class','FUNC','','STRUCT','CALLS']) as k loop
    caught := false;
    begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'K',v.k,0,0,1,0); exception when check_violation then caught := true; end;
    assert caught, format('symbol kind rejected: [%s]', v.k);
  end loop;
  for v in select k from unnest(array['CLASS','INTERFACE','FUNCTION','METHOD','CONSTRUCTOR','VARIABLE','CONSTANT','ENUM','TYPE','MODULE']) as k loop
    insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'kind_' || v.k,v.k,0,0,1,0);
  end loop;
  select count(*) into n from public.repository_symbols where analysis_id = an_a2 and name like 'kind\_%'; assert n = 10, 'all 10 symbol kinds accepted';
  for v in select k from unnest(array['public','OPEN','','FILE']) as k loop
    caught := false;
    begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column,visibility) values (an_a2,f_a2_1,'V','CLASS',0,0,1,0,v.k); exception when check_violation then caught := true; end;
    assert caught, format('visibility rejected: [%s]', v.k);
  end loop;
  for v in select k from unnest(array['PUBLIC','PRIVATE','PROTECTED','INTERNAL','PACKAGE','UNKNOWN']) as k loop
    insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column,visibility) values (an_a2,f_a2_1,'vis_' || v.k,'VARIABLE',0,0,1,0,v.k);
  end loop;
  for v in select nm from unnest(array['', '   ', repeat('x',501)]) as nm loop
    caught := false;
    begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,v.nm,'CLASS',0,0,1,0); exception when check_violation then caught := true; end;
    assert caught, format('symbol name rejected: length %s', char_length(v.nm));
  end loop;
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,repeat('x',500),'VARIABLE',0,0,1,0);
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,qualified_name,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Q','CLASS',repeat('q',1001),0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'qualified_name over 1000 chars rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,qualified_name,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Q','CLASS','',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'empty qualified_name rejected (NULL means unknown)';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,signature,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'S','CLASS',repeat('s',2001),0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'signature over 2000 chars rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,signature,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'S','CLASS','',0,0,1,0); exception when check_violation then caught := true; end;
  assert caught, 'empty signature rejected (NULL means unknown)';
  for v in select a, b, c, d from (values (-1,0,1,0),(0,-1,1,0),(0,0,-1,0),(0,0,1,-1)) as t(a,b,c,d) loop
    caught := false;
    begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'P','CLASS',v.a,v.b,v.c,v.d); exception when check_violation then caught := true; end;
    assert caught, format('negative position rejected: %s,%s,%s,%s', v.a, v.b, v.c, v.d);
  end loop;
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'P','CLASS',5,3,4,9); exception when check_violation then caught := true; end;
  assert caught, 'end line before start line rejected';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'P','CLASS',5,8,5,3); exception when check_violation then caught := true; end;
  assert caught, 'end column before start column on the same line rejected';
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'oneline','VARIABLE',5,3,5,3);
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (null,f_a2_1,'N','CLASS',0,0,1,0); exception when not_null_violation or check_violation then caught := true; end;
  assert caught, 'a symbol requires an analysis';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,null,'N','CLASS',0,0,1,0); exception when not_null_violation or check_violation then caught := true; end;
  assert caught, 'a symbol requires a file';
  caught := false;
  begin insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Other','CLASS',0,0,1,0); exception when unique_violation then caught := true; end;
  assert caught, 'duplicate symbol (same analysis, file, kind, name, start) rejected';
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Other','CLASS',9,0,10,0);
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_a2,f_a2_1,'Other','INTERFACE',0,0,1,0);
  declare s_o uuid; s_k uuid; s_a_svc uuid; rel_id uuid; begin
    select id into s_o from public.repository_symbols where analysis_id = an_a2 and name = 'Other' and kind = 'CLASS' and start_line = 0;
    select id into s_k from public.repository_symbols where analysis_id = an_a2 and name = 'kind_FUNCTION';
    s_a_svc := sy_svc;
    insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_k,'CONTAINS') returning id into rel_id;
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_a_svc,'EXTENDS'); exception when check_violation then caught := true; end;
    assert caught, 'cross-analysis isolation: target symbol from another analysis rejected';
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_a_svc,s_o,'EXTENDS'); exception when check_violation then caught := true; end;
    assert caught, 'cross-analysis isolation: source symbol from another analysis rejected';
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,'00000000-0000-0000-0000-00000000ffff',s_o,'EXTENDS'); exception when check_violation or foreign_key_violation then caught := true; end;
    assert caught, 'nonexistent source symbol rejected';
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a,s_a_svc,s_a_svc,'CALLS'); exception when check_violation then caught := true; end;
    assert caught, 'relationship into a COMPLETED analysis rejected (write window), even with valid symbols';
    caught := false;
    begin update public.repository_symbol_relationships set target_symbol_id = s_a_svc where id = rel_id; exception when check_violation then caught := true; end;
    assert caught, 'a relationship cannot be re-pointed (immutable)';
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_o,'CONTAINS'); exception when check_violation then caught := true; end;
    assert caught, 'a symbol cannot CONTAIN itself';
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_o,'EXTENDS'); exception when check_violation then caught := true; end;
    assert caught, 'a symbol cannot EXTEND itself';
    insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_o,'CALLS');
    insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_o,'REFERENCES');
    for v in select t from unnest(array['contains','USES','DEPENDS_ON','']) as t loop
      caught := false;
      begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_k,s_o,v.t); exception when check_violation then caught := true; end;
      assert caught, format('relationship type rejected: [%s]', v.t);
    end loop;
    for v in select t from unnest(array['CONTAINS','IMPORTS','CALLS','EXTENDS','IMPLEMENTS','REFERENCES']) as t loop
      insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_k,s_o,v.t);
    end loop;
    caught := false;
    begin insert into public.repository_symbol_relationships (analysis_id,source_symbol_id,target_symbol_id,relationship_type) values (an_a2,s_o,s_k,'CONTAINS'); exception when unique_violation then caught := true; end;
    assert caught, 'duplicate relationship rejected';
    caught := false;
    begin update public.repository_symbols set name = 'renamed' where id = s_o; exception when check_violation then caught := true; end;
    assert caught, 'a symbol of a PROCESSING analysis cannot be UPDATEd (generated structure is immutable)';
    caught := false;
    begin update public.repository_symbol_relationships set relationship_type = 'REFERENCES' where id = rel_id; exception when check_violation then caught := true; end;
    assert caught, 'a relationship of a PROCESSING analysis cannot be UPDATEd (generated structure is immutable)';
    begin delete from public.repository_symbols where id = s_k; exception when foreign_key_violation then assert false, 'deleting a symbol must cascade to its relationships (FK)'; end;
    select count(*) into n from public.repository_symbol_relationships where source_symbol_id = s_k or target_symbol_id = s_k; assert n = 0, 'deleting a symbol cascades to its relationships';
  end;

  ---------------------------------------------------------------- RETRY AFTER A FAILED RUN (an_bb, org 2): old structure cleared, new token, signed persist
  set local role authenticated; perform public.zz_as(owner2);
  select * into r from public.begin_structure_analysis(an_bb);
  tok_b := r.run_token;
  reset role;
  insert into public.repository_symbols (analysis_id,file_id,name,kind,start_line,start_column,end_line,end_column) values (an_bb,f_bb,'Leftover','CLASS',0,0,1,0);
  set local role authenticated; perform public.zz_as(owner2);
  select * into r from public.fail_structure_analysis(an_bb, 'interrupted');
  reset role;
  assert not exists (select 1 from public.repository_symbols where analysis_id = an_bb), 'a failed run leaves no structure behind';
  assert not exists (select 1 from private.structure_analysis_runs where analysis_id = an_bb), 'a failed run leaves no token behind';
  set local role authenticated; perform public.zz_as(owner2);
  select * into r from public.reset_structure_analysis(an_bb);
  select * into r from public.begin_structure_analysis(an_bb);
  assert r.run_token <> tok_b, 'the retry run has a different token';
  tok_new := r.run_token;
  syms2 := jsonb_build_array(public.zz_sym(f_bb, 'Fresh', 'CLASS'));
  reset role;
  update public.repository_structure_analyses set error_message = 'stale' where id = an_bb;
  set local role authenticated; perform public.zz_as(owner2);
  caught := false; msg := null;
  begin perform public.persist_structure_analysis(an_bb, tok_b, syms2, '[]'::jsonb, 1, 1, 0, 0, public.zz_sig(an_bb, tok_b, syms2, '[]'::jsonb, 1, 1, 0, 0));
  exception when others then caught := (sqlstate = '42501'); msg := sqlerrm; end;
  assert caught and msg = 'Invalid run token', 'the run token of the failed attempt cannot be replayed into the retry; got ' || coalesce(msg, 'no error');
  begin
    select * into r from public.persist_structure_analysis(an_bb, tok_new, syms2, '[]'::jsonb, 1, 1, 0, 0, public.zz_sig(an_bb, tok_new, syms2, '[]'::jsonb, 1, 1, 0, 0));
  exception when others then assert false, 'persisting the retried structure must succeed, got ' || sqlstate || ' ' || sqlerrm; end;
  assert r.status = 'COMPLETED' and r.symbols_count = 1, 'a retried analysis completes with only its fresh structure';
  reset role;
  select * into r from public.repository_structure_analyses where id = an_bb;
  assert r.error_message is null and r.completed_at is not null, 'persist clears a stale error_message and records completed_at';

  ---------------------------------------------------------------- DELETE: authorization and cascade
  set local role authenticated;
  perform public.zz_as(ma);
  delete from public.repository_structure_analyses where id = an_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER cannot delete an analysis';
  perform public.zz_as(mb);
  delete from public.repository_structure_analyses where id = an_a;
  get diagnostics n = row_count; assert n = 0, 'cross-team member cannot delete an analysis';
  perform public.zz_as(owner2);
  delete from public.repository_structure_analyses where id = an_a;
  get diagnostics n = row_count; assert n = 0, 'cross-tenant owner cannot delete an org 1 analysis';
  perform public.zz_as(admin1);
  begin delete from public.repository_structure_analyses where id = an_a; exception when foreign_key_violation then assert false, 'deleting an analysis must cascade to its structure (FK)'; end;
  get diagnostics n = row_count; assert n = 1, 'ADMIN can delete a COMPLETED analysis';
  begin delete from public.repository_structure_analyses where id = an_a2; exception when foreign_key_violation then assert false, 'deleting a PROCESSING analysis must cascade to its structure and run token'; end;
  get diagnostics n = row_count; assert n = 1, 'ADMIN can delete a PROCESSING analysis';
  reset role;
  assert not exists (select 1 from public.repository_symbols where analysis_id in (an_a, an_a2)), 'deleting an analysis cascades to its symbols';
  assert not exists (select 1 from public.repository_symbol_relationships where analysis_id in (an_a, an_a2)), 'deleting an analysis cascades to its relationships';
  assert not exists (select 1 from private.structure_analysis_runs where analysis_id in (an_a, an_a2)), 'deleting an analysis cascades to its run token';
  assert (select count(*) from public.repository_symbols where analysis_id = an_bb) = 1, 'other analyses are untouched by the delete';
  set local role authenticated; perform public.zz_as(owner1);
  select * into r from public.create_structure_analysis(s_a);
  assert r.status = 'PENDING' and r.snapshot_id = s_a, 'a snapshot can be analysed again after its analysis was deleted';
  reset role;

  begin delete from public.repository_snapshots where id = s_bb; exception when foreign_key_violation then assert false, 'deleting a snapshot must cascade to its analysis and structure (FK)'; end;
  assert not exists (select 1 from public.repository_structure_analyses where id = an_bb), 'deleting a snapshot cascades to its analysis';
  assert not exists (select 1 from public.repository_symbols where analysis_id = an_bb), 'deleting a snapshot cascades to its symbols';
  assert not exists (select 1 from private.structure_analysis_runs where analysis_id = an_bb), 'deleting a snapshot cascades to its run state';
  caught := false; begin delete from public.repository_files where id = f_a2_1; exception when check_violation then caught := true; end;
  assert caught, 'a manifest row of a COMPLETED snapshot cannot be deleted on its own (seal trigger, 20261018000001)';
  alter table public.repository_files disable trigger repository_files_enforce_immutability;
  begin delete from public.repository_files where id = f_a2_1; exception when foreign_key_violation then assert false, 'deleting a file must cascade to its symbols (FK)'; end;
  alter table public.repository_files enable trigger repository_files_enforce_immutability;

  raise notice 'repository_structure_rls.sql: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
