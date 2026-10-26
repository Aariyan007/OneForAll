-- Source content store (migration 20261028000002): privileges, hash-verified writes, idempotency, role and tenant
-- denial, state rules, immutability, RLS reads and bounded code search. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_file_contents_rls.sql

set client_encoding = 'UTF8';
begin;

create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

create function public.zz_hash(p_text text) returns text language sql as $$
  select encode(extensions.digest(convert_to(p_text, 'UTF8'), 'sha256'), 'hex');
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000c101';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-00000000c104';  -- ADMIN of org 1
  ma     uuid := '00000000-0000-0000-0000-00000000c102';  -- MEMBER, team A (sees the project)
  mb     uuid := '00000000-0000-0000-0000-00000000c103';  -- MEMBER, team B (does not)
  owner2 uuid := '00000000-0000-0000-0000-00000000c201';  -- OWNER of org 2 (other tenant)
  a_text text := E'export function add(a: number, b: number) {\n  // needle here\n  return a + b;\n}\n';
  b_text text := E'line one\r\nconst ünïcödé = "needle";\r\n';
  x_text text := E'const secret = "needle";\n';
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; rx uuid;
  s1 uuid; sp uuid; sx uuid; fa uuid; fb uuid; fx uuid; fp uuid;
  r record; n int; st text; fn text;
begin
  insert into auth.users (id, email) values (owner1,'co1@c.local'),(admin1,'ca1@c.local'),(ma,'cma@c.local'),(mb,'cmb@c.local'),(owner2,'co2@c.local');
  insert into public.organizations (name,slug,created_by) values ('Content One','content-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Content Two','content-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role)
    values (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/c/p','c','p','main',owner1) returning id into r1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (px,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into rx;

  -- s1: COMPLETED (org 1). sp: still PENDING (org 1). sx: COMPLETED (org 2).
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('b',40),'main') returning id into sp;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (rx,repeat('a',40),'main') returning id into sx;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash)
    values (s1,'src/a.ts','TypeScript',octet_length(convert_to(a_text,'UTF8')),public.zz_hash(a_text)) returning id into fa;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash)
    values (s1,'docs/b.txt',null,octet_length(convert_to(b_text,'UTF8')),public.zz_hash(b_text)) returning id into fb;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash)
    values (sp,'src/a.ts','TypeScript',octet_length(convert_to(a_text,'UTF8')),public.zz_hash(a_text)) returning id into fp;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash)
    values (sx,'secret.ts','TypeScript',octet_length(convert_to(x_text,'UTF8')),public.zz_hash(x_text)) returning id into fx;
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id in (s1, sx);
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id in (s1, sx);

  ---------------------------------------------------------------- catalog
  select p.prosecdef, p.proconfig, p.proacl into r from pg_proc p where p.oid = 'public.store_snapshot_contents(uuid,jsonb)'::regprocedure;
  assert r.prosecdef, 'store_snapshot_contents: SECURITY DEFINER (writes past the no-write RLS)';
  assert r.proconfig @> array['search_path=""'], 'store_snapshot_contents: empty search_path';
  fn := 'public.repository_code_search(uuid,text,integer)';
  select p.prosecdef, p.proconfig, p.provolatile into r from pg_proc p where p.oid = fn::regprocedure;
  assert not r.prosecdef, 'code search: SECURITY INVOKER (RLS of the caller applies)';
  assert r.proconfig @> array['search_path=""'], 'code search: empty search_path';
  assert r.provolatile = 's', 'code search: STABLE';
  foreach fn in array array['public.store_snapshot_contents(uuid,jsonb)', 'public.repository_code_search(uuid,text,integer)'] loop
    assert has_function_privilege('authenticated', fn, 'execute'), fn || ': authenticated can execute';
    assert not has_function_privilege('anon', fn, 'execute'), fn || ': anon cannot execute';
  end loop;
  assert not has_table_privilege('authenticated', 'public.repository_file_contents', 'insert'), 'no client INSERT';
  assert not has_table_privilege('authenticated', 'public.repository_file_contents', 'update'), 'no client UPDATE';
  assert not has_table_privilege('authenticated', 'public.repository_file_contents', 'delete'), 'no client DELETE';
  assert not has_table_privilege('anon', 'public.repository_file_contents', 'select'), 'no anon SELECT';
  assert (select relrowsecurity from pg_class where oid = 'public.repository_file_contents'::regclass), 'RLS enabled';

  set local role authenticated;

  ---------------------------------------------------------------- writes: role and tenant denial
  foreach fn in array array[ma::text, mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    st := null;
    begin perform public.store_snapshot_contents(s1, jsonb_build_array(jsonb_build_object('path','src/a.ts','content',a_text)));
    exception when others then st := sqlstate; end;
    assert st = '42501', 'store denied for ' || fn || ' (got ' || coalesce(st, 'none') || ')';
  end loop;

  ---------------------------------------------------------------- writes: hash, path, size, state
  perform public.zz_as(owner1);
  st := null;
  begin perform public.store_snapshot_contents(s1, jsonb_build_array(jsonb_build_object('path','src/a.ts','content',a_text || 'x')));
  exception when others then st := sqlstate; end;
  assert st = '23514', 'content whose hash differs from the manifest is refused (got ' || coalesce(st, 'none') || ')';

  st := null;
  begin perform public.store_snapshot_contents(s1, jsonb_build_array(jsonb_build_object('path','src/none.ts','content',a_text)));
  exception when others then st := sqlstate; end;
  assert st = '23514', 'a path that is not in the manifest is refused';

  st := null;
  begin perform public.store_snapshot_contents(s1, jsonb_build_array(jsonb_build_object('path','src/a.ts','content',repeat('x', 1000001))));
  exception when others then st := sqlstate; end;
  assert st = '22023', 'content over 1,000,000 bytes is refused';

  st := null;
  begin perform public.store_snapshot_contents(s1, '{"path":"src/a.ts"}'::jsonb);
  exception when others then st := sqlstate; end;
  assert st = '22023', 'a non-array payload is refused';

  st := null;
  begin perform public.store_snapshot_contents(sp, jsonb_build_array(jsonb_build_object('path','src/a.ts','content',a_text)));
  exception when others then st := sqlstate; end;
  assert st = '55000', 'a snapshot that is not COMPLETED is refused';

  -- A bad element rejects the whole batch: nothing from it is stored.
  st := null;
  begin perform public.store_snapshot_contents(s1, jsonb_build_array(
    jsonb_build_object('path','src/a.ts','content',a_text), jsonb_build_object('path','docs/b.txt','content','tampered')));
  exception when others then st := sqlstate; end;
  assert st = '23514', 'mixed batch refused';
  reset role;
  select count(*) into n from public.repository_file_contents where snapshot_id = s1;
  assert n = 0, 'a refused batch stores nothing';
  set local role authenticated;

  ---------------------------------------------------------------- writes: success and idempotency (ADMIN may store)
  perform public.zz_as(admin1);
  select * into r from public.store_snapshot_contents(s1, jsonb_build_array(
    jsonb_build_object('path','src/a.ts','content',a_text), jsonb_build_object('path','docs/b.txt','content',b_text)));
  assert r.stored = 2 and r.already_stored = 0, 'ADMIN stores both files';
  select * into r from public.store_snapshot_contents(s1, jsonb_build_array(jsonb_build_object('path','src/a.ts','content',a_text)));
  assert r.stored = 0 and r.already_stored = 1, 'storing again is a no-op';

  ---------------------------------------------------------------- direct writes are denied
  st := null;
  begin insert into public.repository_file_contents (file_id, snapshot_id, content, byte_size) values (fx, sx, 'x', 1);
  exception when others then st := sqlstate; end;
  assert st = '42501', 'direct INSERT denied';

  ---------------------------------------------------------------- reads: RLS
  foreach fn in array array[owner1::text, ma::text] loop
    perform public.zz_as(fn::uuid);
    select count(*) into n from public.repository_file_contents where snapshot_id = s1;
    assert n = 2, 'contents visible to ' || fn;
    select content into st from public.repository_file_contents where file_id = fb;
    assert st = b_text, 'content round-trips exactly (CRLF and non-ASCII) for ' || fn;
  end loop;
  foreach fn in array array[mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    select count(*) into n from public.repository_file_contents where snapshot_id = s1;
    assert n = 0, 'contents hidden from ' || fn;
  end loop;

  ---------------------------------------------------------------- code search
  perform public.zz_as(ma);
  select count(*) into n from public.repository_code_search(s1, 'needle', 50);
  assert n = 2, 'search finds one line in each file';
  select path, line_number, line into r from public.repository_code_search(s1, 'needle', 50) where path = 'src/a.ts';
  assert r.line_number = 2 and r.line = '  // needle here', 'search returns the 1-based line number and the line';
  select line_number, line into r from public.repository_code_search(s1, 'NEEDLE', 50) where path = 'docs/b.txt';
  assert r.line_number = 2 and r.line = 'const ünïcödé = "needle";', 'case-insensitive, CRLF stripped from the line';
  select count(*) into n from public.repository_code_search(s1, 'needle', 1);
  assert n = 1, 'limit applies';
  st := null; begin perform public.repository_code_search(s1, 'n', 50); exception when others then st := sqlstate; end;
  assert st = '22023', 'query shorter than 2 characters refused';
  st := null; begin perform public.repository_code_search(s1, repeat('n', 201), 50); exception when others then st := sqlstate; end;
  assert st = '22023', 'query longer than 200 characters refused';
  st := null; begin perform public.repository_code_search(s1, 'needle', 51); exception when others then st := sqlstate; end;
  assert st = '22023', 'limit above 50 refused';
  perform public.zz_as(mb);
  select count(*) into n from public.repository_code_search(s1, 'needle', 50);
  assert n = 0, 'search hidden from another team';
  perform public.zz_as(owner2);
  select count(*) into n from public.repository_code_search(s1, 'needle', 50);
  assert n = 0, 'search hidden from another tenant';

  ---------------------------------------------------------------- immutability (even for the table owner)
  reset role;
  st := null;
  begin update public.repository_file_contents set content = 'changed' where file_id = fa;
  exception when others then st := sqlstate; end;
  assert st = '55000', 'stored content cannot be changed';

  -- Content goes with its file: deleting the snapshot's files removes the contents.
  delete from public.repository_snapshots where id = s1;
  select count(*) into n from public.repository_file_contents where snapshot_id = s1;
  assert n = 0, 'contents are removed with their snapshot';

  raise notice 'repository_file_contents_rls: all checks passed';
end;
$$;

rollback;
