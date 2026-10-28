-- File-to-file edges (migration 20261029000001): who may store, validation, replace semantics and RLS reads.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_file_edges_rls.sql
set client_encoding = 'UTF8';
begin;
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000d101'; ma uuid := '00000000-0000-0000-0000-00000000d102';
  mb uuid := '00000000-0000-0000-0000-00000000d103'; owner2 uuid := '00000000-0000-0000-0000-00000000d201';
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; rx uuid;
  s1 uuid; sp uuid; sx uuid; fa uuid; fb uuid; fc uuid; r record; n int; st text;
begin
  insert into auth.users (id, email) values (owner1,'do1@d.local'),(ma,'dma@d.local'),(mb,'dmb@d.local'),(owner2,'do2@d.local');
  insert into public.organizations (name,slug,created_by) values ('Edges One','edges-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Edges Two','edges-two',owner2) returning id into org2;
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
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/e/p','e','p','main',owner1) returning id into r1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (px,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into rx;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('b',40),'main') returning id into sp;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (rx,repeat('a',40),'main') returning id into sx;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'a.ts','TypeScript',1,repeat('1',64)) returning id into fa;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'b.ts','TypeScript',1,repeat('2',64)) returning id into fb;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'c.ts','TypeScript',1,repeat('3',64)) returning id into fc;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (sp,'a.ts','TypeScript',1,repeat('1',64));
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (sx,'x.ts','TypeScript',1,repeat('9',64));
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id in (s1, sx);
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id in (s1, sx);

  assert (select prosecdef from pg_proc where oid = 'public.store_file_edges(uuid,jsonb)'::regprocedure), 'definer';
  assert not has_function_privilege('anon', 'public.store_file_edges(uuid,jsonb)', 'execute'), 'anon cannot execute';
  assert not has_table_privilege('authenticated', 'public.repository_file_edges', 'insert'), 'no client insert';
  assert (select relrowsecurity from pg_class where oid = 'public.repository_file_edges'::regclass), 'RLS';
  set local role authenticated;

  foreach st in array array[ma::text, mb::text, owner2::text] loop
    perform public.zz_as(st::uuid);
    begin perform public.store_file_edges(s1, '[{"source":"a.ts","target":"b.ts","specifier":"./b"}]'::jsonb); st := 'none';
    exception when others then st := sqlstate; end;
    assert st = '42501', 'store denied for non-admins (got ' || st || ')';
  end loop;

  perform public.zz_as(owner1);
  select public.store_file_edges(s1, '[{"source":"a.ts","target":"b.ts","specifier":"./b"},{"source":"b.ts","target":"c.ts","specifier":"./c"}]'::jsonb) into n;
  assert n = 2, 'owner stores two edges';
  select public.store_file_edges(s1, '[{"source":"a.ts","target":"c.ts","specifier":"./c"}]'::jsonb) into n;
  assert n = 1, 'a rebuild replaces the previous edges';
  select count(*) into n from public.repository_file_edges where snapshot_id = s1; assert n = 1, 'only the new edge remains';

  st := null; begin perform public.store_file_edges(s1, '[{"source":"a.ts","target":"nope.ts","specifier":"x"}]'::jsonb); exception when others then st := sqlstate; end;
  assert st = '23514', 'unknown path refused';
  st := null; begin perform public.store_file_edges(s1, '[{"source":"a.ts","target":"a.ts","specifier":"x"}]'::jsonb); exception when others then st := sqlstate; end;
  assert st = '23514', 'self edge refused';
  st := null; begin perform public.store_file_edges(sp, '[]'::jsonb); exception when others then st := sqlstate; end;
  assert st = '55000', 'snapshot must be COMPLETED';
  st := null; begin perform public.store_file_edges(s1, '{}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '22023', 'payload must be an array';

  perform public.zz_as(ma);
  select count(*) into n from public.repository_file_edges where snapshot_id = s1; assert n = 1, 'team member sees edges';
  foreach st in array array[mb::text, owner2::text] loop
    perform public.zz_as(st::uuid);
    select count(*) into n from public.repository_file_edges where snapshot_id = s1; assert n = 0, 'edges hidden from ' || st;
  end loop;
  raise notice 'repository_file_edges_rls: all checks passed';
end;
$$;
rollback;
