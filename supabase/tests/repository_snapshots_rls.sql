-- Phase 2G authorization, isolation, integrity and lifecycle checks for repository snapshots and the file manifest.
-- One transaction, rolled back at the end.
-- Since migration 20261018000001 clients have NO direct write path to the manifest or the snapshot lifecycle: every
-- OWNER/ADMIN direct INSERT/DELETE on repository_files and UPDATE on repository_snapshots is denied, and the lifecycle
-- moves only through begin/persist/fail_snapshot_ingestion (fully covered by repository_manifest_lifecycle_rls.sql).
-- Table CHECKs, uniqueness and the lifecycle trigger hold for every writer, so they are exercised here as superuser.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_snapshots_rls.sql

begin;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-000000000e01';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-000000000e02';  -- ADMIN of org 1 (in no team)
  ma     uuid := '00000000-0000-0000-0000-000000000e03';  -- MEMBER, dept 1, team A
  mb     uuid := '00000000-0000-0000-0000-000000000e04';  -- MEMBER, dept 1, team B   (same dept, different team)
  mdept  uuid := '00000000-0000-0000-0000-000000000e05';  -- MEMBER, dept 1, NO team
  mx     uuid := '00000000-0000-0000-0000-000000000e06';  -- MEMBER of org 1, no dept, no team
  mo     uuid := '00000000-0000-0000-0000-000000000e07';  -- MEMBER, dept 2, team C   (other department)
  owner2 uuid := '00000000-0000-0000-0000-000000000f01';  -- OWNER of org 2 (other tenant)
  m2     uuid := '00000000-0000-0000-0000-000000000f02';  -- MEMBER of org 2, team BB
  sha1   text := repeat('a', 40);
  sha2   text := repeat('b', 40);
  sha3   text := repeat('c', 40);
  sha256 text := repeat('d', 64);
  h1     text := repeat('1', 64);
  h2     text := repeat('2', 64);
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; deptb uuid;
  team_a uuid; team_b uuid; team_c uuid; team_bb uuid;
  p_a uuid; p_b uuid; p_bb uuid; p_empty uuid;
  repo_a uuid; repo_b uuid; repo_bb uuid; repo_empty uuid;
  s_a uuid; s_a2 uuid; s_b uuid; s_bb uuid; s uuid;
  f_a uuid; f_b uuid; f_bb uuid; f uuid;
  r record; v record; c record; n int; caught boolean;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values
    (owner1,'o1@s.local'),(admin1,'a1@s.local'),(ma,'ma@s.local'),(mb,'mb@s.local'),(mdept,'md@s.local'),
    (mx,'mx@s.local'),(mo,'mo@s.local'),(owner2,'o2@s.local'),(m2,'m2@s.local');
  insert into public.organizations (name,slug,created_by) values ('Org One','org-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Org Two','org-two',owner2) returning id into org2;
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
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'Empty','empty','BROWNFIELD',owner1) returning id into p_empty;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_a,'GITHUB','https://github.com/acme/payments','acme','payments','main',owner1) returning id into repo_a;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_b,'GITHUB','https://github.com/acme/hiring','acme','hiring','main',owner1) returning id into repo_b;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_bb,'GITHUB','https://github.com/globex/payments','globex','payments','main',owner2) returning id into repo_bb;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_empty,'GITHUB','https://github.com/acme/empty','acme','empty','main',owner1) returning id into repo_empty;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,sha1,'main') returning id into s_a;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_b,sha1,'main') returning id into s_b;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_bb,sha1,'main') returning id into s_bb;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'src/index.ts','TypeScript',10,h1) returning id into f_a;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_b,'src/hiring.py','Python',20,h1) returning id into f_b;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_bb,'src/index.ts','TypeScript',10,h1) returning id into f_bb;

  -- Defaults (superuser insert above used no status) --------------------------
  select * into r from public.repository_snapshots where id = s_a;
  assert r.status = 'PENDING' and r.started_at is null and r.completed_at is null and r.error_message is null, 'snapshot defaults to PENDING with no timestamps';
  assert r.created_at is not null, 'snapshot created_at set';

  ---------------------------------------------------------------- anonymous denied
  set local role anon;
  caught := false; begin perform count(*) from public.repository_snapshots; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read snapshots';
  caught := false; begin perform count(*) from public.repository_files; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read files';
  caught := false; begin perform public.create_repository_snapshot(repo_a, sha2, 'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not create snapshots (RPC)';
  caught := false;
  begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a,'x.txt',1,h1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not insert files';
  reset role;

  ---------------------------------------------------------------- SNAPSHOT: create by role, forged ids
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select * into r from public.create_repository_snapshot(repo_a, '  ' || upper(sha2) || '  ', '  release  ');
  s_a2 := r.id;
  assert r.status = 'PENDING' and r.repository_id = repo_a, 'OWNER creates snapshot, always PENDING';
  assert r.commit_sha = sha2, 'commit sha is trimmed and normalized to lowercase';
  assert r.branch = 'release', 'branch is trimmed and never assumed to be main';
  select * into r from public.create_repository_snapshot(repo_a, sha256, 'main');
  assert r.commit_sha = sha256, 'a 64-char (SHA-256) commit id is accepted';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select * into r from public.create_repository_snapshot(repo_b, sha2, 'develop');
  assert r.repository_id = repo_b, 'ADMIN creates snapshot for a repository of a team they are not in';

  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false; begin perform public.create_repository_snapshot(repo_a, sha3, 'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create snapshots (RPC)';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,sha3,'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create snapshots (direct INSERT)';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  caught := false; begin perform public.create_repository_snapshot(repo_a, sha3, 'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'cross-team: team B member must not create a snapshot for team A repository';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  caught := false; begin perform public.create_repository_snapshot(repo_a, sha3, 'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged repository_id of another organization rejected (RPC)';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,sha3,'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged repository_id of another organization rejected (direct INSERT)';
  caught := false; begin perform public.create_repository_snapshot('00000000-0000-0000-0000-00000000ffff', sha3, 'main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent repository_id rejected for clients';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  for v in select st from unnest(array['PROCESSING','COMPLETED','FAILED']) as st loop
    caught := false;
    begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a,sha3,'main',v.st);
    exception when insufficient_privilege then caught := true; end;
    assert caught, format('initial status forced to PENDING: direct insert as %s denied', v.st);
  end loop;
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a,sha3,'main','PENDING');
  exception when insufficient_privilege then caught := true; end;
  assert not caught, 'a direct insert as PENDING is allowed for OWNER';
  delete from public.repository_snapshots where repository_id = repo_a and commit_sha = sha3;
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,started_at) values (repo_a,sha3,'main',now());
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'a snapshot cannot be created with started_at already set (privilege)';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,error_message) values (repo_a,sha3,'main','x');
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'a snapshot cannot be created with an error_message (privilege)';

  ---------------------------------------------------------------- SNAPSHOT: value validation
  for v in select x from unnest(array[
      repeat('a',39), repeat('a',41), repeat('g',40), repeat('A',40), '', 'main', 'HEAD', repeat('a',63), repeat('a',65),
      repeat('a',20) || ' ' || repeat('a',19), repeat('a',40) || E'\n']) as x
  loop
    caught := false;
    begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a, v.x, 'main'); exception when check_violation then caught := true; end;
    assert caught, format('commit_sha rejected: [%s]', left(replace(v.x, E'\n', '\n'), 45));
  end loop;
  caught := false; begin perform public.create_repository_snapshot(repo_a, 'main', 'main'); exception when check_violation then caught := true; end;
  assert caught, 'RPC rejects a branch name used as a commit sha';
  for v in select b from unnest(array['', 'my branch', 'tab' || chr(9) || 'x', 'nl' || chr(10) || 'x', 'cr' || chr(13), chr(1) || 'x', 'del' || chr(127),
      'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\b', '-flag', 'a..b', repeat('x',256)]) as b
  loop
    caught := false;
    begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a, sha3, v.b); exception when check_violation then caught := true; end;
    assert caught, format('branch rejected: [%s]', left(encode(convert_to(v.b,'UTF8'),'escape'), 25));
  end loop;
  caught := false; begin perform public.create_repository_snapshot(repo_a, sha3, '   '); exception when check_violation then caught := true; end;
  assert caught, 'blank branch rejected';
  for v in select b from unnest(array['main','master','trunk','develop','release/1.2','feature/x_y-z','v1.0']) as b loop
    insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a, sha3, v.b);
    delete from public.repository_snapshots where repository_id = repo_a and commit_sha = sha3;
  end loop;
  reset role;
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a, null, 'main'); exception when not_null_violation then caught := true; end;
  assert caught, 'commit_sha is required';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha) values (repo_a, sha3); exception when not_null_violation then caught := true; end;
  assert caught, 'branch is required (no silent main)';
  caught := false;
  begin insert into public.repository_snapshots (commit_sha,branch) values (sha3, 'main'); exception when not_null_violation then caught := true; end;
  assert caught, 'a snapshot requires a repository';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch) values ('00000000-0000-0000-0000-00000000ffff', sha3, 'main'); exception when foreign_key_violation then caught := true; end;
  assert caught, 'snapshot must reference an existing repository (FK)';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a, sha3, 'main', 'DONE'); exception when check_violation then caught := true; end;
  assert caught, 'invalid status rejected';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,error_message) values (repo_a, sha3, 'main', repeat('x',2001)); exception when check_violation then caught := true; end;
  assert caught, 'error_message over 2000 chars rejected';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_a, sha3, 'main', 'FAILED', now(), now() - interval '1 hour'); exception when check_violation then caught := true; end;
  assert caught, 'completed_at before started_at rejected';
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a, sha3, 'main', 'COMPLETED'); exception when check_violation then caught := true; end;
  assert caught, 'a COMPLETED snapshot must have completed_at';

  ---------------------------------------------------------------- SNAPSHOT: duplicate completed commits, retry
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_a, sha3, 'main', 'COMPLETED', now(), now());
  caught := false;
  begin insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_a, sha3, 'other', 'COMPLETED', now(), now()); exception when unique_violation then caught := true; end;
  assert caught, 'a second COMPLETED snapshot of the same commit is rejected (any branch)';
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_a, repeat('e',40), 'main', 'COMPLETED', now(), now());
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status,started_at,completed_at) values (repo_b, sha3, 'main', 'COMPLETED', now(), now());
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a, sha3, 'main');
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a, sha3, 'main', 'FAILED');
  insert into public.repository_snapshots (repository_id,commit_sha,branch,status) values (repo_a, sha3, 'main', 'FAILED');
  select count(*) into n from public.repository_snapshots where repository_id = repo_a and commit_sha = sha3;
  assert n = 4, 'one COMPLETED plus PENDING/FAILED duplicates of the same commit are allowed (retry); saw ' || n;
  delete from public.repository_snapshots where repository_id = repo_a and commit_sha in (sha3, repeat('e',40));
  delete from public.repository_snapshots where repository_id = repo_b and commit_sha = sha3;

  ---------------------------------------------------------------- SNAPSHOT: visibility
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where id in (s_a,s_a2,s_b); assert n = 3, 'OWNER sees snapshots of all org 1 repositories';
  select count(*) into n from public.repository_snapshots where id = s_bb; assert n = 0, 'OWNER cannot see org 2 snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where id in (s_a,s_a2,s_b); assert n = 3, 'ADMIN sees snapshots of all org 1 repositories, even in no team';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where repository_id = repo_a; assert n >= 2, 'team A MEMBER can view their repository snapshots (read-only)';
  select count(*) into n from public.repository_snapshots where id = s_b; assert n = 0, 'cross-team: team A member cannot see team B snapshot';
  select count(*) into n from public.repository_snapshots where id = s_bb; assert n = 0, 'cross-organization: org 1 member cannot see org 2 snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where id in (s_a,s_a2); assert n = 0, 'team B member cannot see team A snapshots (same department)';
  select count(*) into n from public.repository_snapshots where id = s_b; assert n = 1, 'team B member sees own repository snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',mdept,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots; assert n = 0, 'same-department user with no team sees no snapshots';
  perform set_config('request.jwt.claims', json_build_object('sub',mx,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots; assert n = 0, 'non-team org member sees no snapshots';
  perform set_config('request.jwt.claims', json_build_object('sub',mo,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots; assert n = 0, 'other-department user sees no snapshots';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where id in (s_a,s_a2,s_b); assert n = 0, 'other organization sees no org 1 snapshots';
  select count(*) into n from public.repository_snapshots; assert n = 1, 'org 2 owner sees only org 2 snapshots';
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots where repository_id = repo_empty; assert n = 0, 'a repository with no snapshots yields none';
  select count(*) into n from public.repository_snapshots where repository_id = repo_a; assert n = 3, 'a repository can have multiple snapshots, saw ' || n;

  ---------------------------------------------------------------- SNAPSHOT: no direct UPDATE by anyone; lifecycle via the ingestion functions; delete by role
  for v in select uid, who from (values (owner1,'OWNER'),(admin1,'ADMIN'),(ma,'team MEMBER'),(mb,'wrong-team MEMBER'),(owner2,'org 2 OWNER')) as x(uid, who) loop
    perform set_config('request.jwt.claims', json_build_object('sub',v.uid,'role','authenticated')::text, true);
    for c in select clause from unnest(array[
        'status = ''PROCESSING'', started_at = now()', 'status = ''FAILED'', completed_at = now(), error_message = ''x''',
        'status = ''COMPLETED'', completed_at = now()', 'error_message = ''x''', 'started_at = now()', 'completed_at = now()']) as clause
    loop
      foreach s in array array[s_a, s_b, s_bb] loop
        caught := false;
        begin execute 'update public.repository_snapshots set ' || c.clause || ' where id = $1' using s;
        exception when insufficient_privilege then caught := true; end;
        assert caught, format('%s: direct snapshot UPDATE (%s) must be denied', v.who, c.clause);
      end loop;
    end loop;
  end loop;
  -- The lifecycle moves through the ingestion functions, which re-check OWNER/ADMIN themselves.
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  perform public.begin_snapshot_ingestion(s_a2);
  select status into r from public.repository_snapshots where id = s_a2;
  assert r.status = 'PROCESSING', 'OWNER moves snapshot to PROCESSING (begin_snapshot_ingestion)';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo_b, repeat('f',40), 'main');
  perform public.begin_snapshot_ingestion(s);
  select status into r from public.repository_snapshots where id = s;
  assert r.status = 'PROCESSING', 'ADMIN moves a snapshot of a team they are not in to PROCESSING (begin_snapshot_ingestion)';
  delete from public.repository_snapshots where id = s;
  caught := false; begin perform public.begin_snapshot_ingestion(s_bb); exception when insufficient_privilege then caught := true; end;
  assert caught, 'org 1 admin must not start ingestion of an org 2 snapshot';
  delete from public.repository_snapshots where id = s_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not delete org 2 snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false; begin perform public.begin_snapshot_ingestion(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER (can read) must not change snapshot state';
  delete from public.repository_snapshots where id = s_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not delete snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  caught := false; begin perform public.begin_snapshot_ingestion(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'wrong-team MEMBER must not change snapshot state';
  delete from public.repository_snapshots where id = s_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not delete snapshot';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  caught := false; begin perform public.begin_snapshot_ingestion(s_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'org 2 owner must not change org 1 snapshot state';
  delete from public.repository_snapshots where id = s_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not delete org 1 snapshot';
  reset role;
  select count(*) into n from public.repository_snapshots where id in (s_a, s_b, s_bb) and status = 'PENDING';
  assert n = 3, 'no denied call changed a snapshot';
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false; begin update public.repository_snapshots set repository_id = repo_empty where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'repository_id (same team, other repository) is immutable';
  caught := false; begin update public.repository_snapshots set repository_id = repo_bb where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'repository_id (other organization) is immutable';
  caught := false; begin update public.repository_snapshots set commit_sha = sha3 where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'commit_sha is immutable';
  caught := false; begin update public.repository_snapshots set branch = 'other' where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'branch is immutable';
  caught := false; begin update public.repository_snapshots set created_at = now() - interval '1 day' where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'created_at is immutable';
  caught := false; begin update public.repository_snapshots set id = gen_random_uuid() where id = s_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'snapshot id is immutable';

  ---------------------------------------------------------------- SNAPSHOT: lifecycle, every (from, to) pair
  -- Clients cannot UPDATE snapshots at all (checked above); the lifecycle trigger guards every writer, so the matrix
  -- runs as superuser (the identity the SECURITY DEFINER ingestion functions also write with).
  select id into s from public.create_repository_snapshot(repo_empty, repeat('9',40), 'main');
  for v in
    select fr, tg, ok from (values
      ('PENDING','PENDING',true),('PENDING','PROCESSING',true),('PENDING','COMPLETED',false),('PENDING','FAILED',true),
      ('PROCESSING','PENDING',false),('PROCESSING','PROCESSING',true),('PROCESSING','COMPLETED',true),('PROCESSING','FAILED',true),
      ('COMPLETED','PENDING',false),('COMPLETED','PROCESSING',false),('COMPLETED','COMPLETED',true),('COMPLETED','FAILED',false),
      ('FAILED','PENDING',true),('FAILED','PROCESSING',false),('FAILED','COMPLETED',false),('FAILED','FAILED',true)
    ) as x(fr, tg, ok)
  loop
    reset role;                                              -- force the starting state, bypassing the trigger and CHECKs
    set local session_replication_role = replica;
    update public.repository_snapshots set status = v.fr, started_at = null,
           completed_at = case when v.fr = 'COMPLETED' then now() else null end where id = s;
    set local session_replication_role = origin;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
    caught := false;
    begin update public.repository_snapshots set status = v.tg where id = s; exception when insufficient_privilege then caught := true; end;
    assert caught, format('client UPDATE %s -> %s denied (no UPDATE privilege)', v.fr, v.tg);
    reset role;
    caught := false;
    begin
      update public.repository_snapshots set status = v.tg,
             completed_at = case when v.tg = 'COMPLETED' then now() else completed_at end where id = s;
    exception when check_violation then caught := true; end;
    assert caught = not v.ok, format('snapshot transition %s -> %s: expected %s', v.fr, v.tg, case when v.ok then 'allowed' else 'rejected' end);
    select status into r from public.repository_snapshots where id = s;
    assert r.status = case when v.ok then v.tg else v.fr end, format('snapshot %s -> %s left wrong status %s', v.fr, v.tg, r.status);
  end loop;
  caught := false; begin update public.repository_snapshots set status = 'DONE' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'unknown status rejected on update';
  -- COMPLETED requires completed_at; the retry path clears it.
  set local session_replication_role = replica; update public.repository_snapshots set status = 'PROCESSING', started_at = now(), completed_at = null where id = s; set local session_replication_role = origin;
  caught := false; begin update public.repository_snapshots set status = 'COMPLETED' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'PROCESSING -> COMPLETED without completed_at rejected by CHECK';
  update public.repository_snapshots set status = 'FAILED', completed_at = now(), error_message = 'ingestion failed' where id = s;
  get diagnostics n = row_count; assert n = 1, 'PROCESSING -> FAILED with an error message';
  update public.repository_snapshots set status = 'PENDING', started_at = null, completed_at = null, error_message = null where id = s;
  get diagnostics n = row_count; assert n = 1, 'FAILED -> PENDING retry clears the failure details';
  select * into r from public.repository_snapshots where id = s;
  assert r.status = 'PENDING' and r.error_message is null and r.completed_at is null, 'retry leaves a clean PENDING snapshot';

  ---------------------------------------------------------------- SNAPSHOT: a COMPLETED snapshot is sealed (no column can change)
  -- Force a COMPLETED row with known timestamps, then try every mutable column as OWNER and as ADMIN.
  reset role;
  set local session_replication_role = replica;
  update public.repository_snapshots set status = 'COMPLETED', started_at = timestamptz '2026-01-01 10:00:00+00',
         completed_at = timestamptz '2026-01-01 10:05:00+00', error_message = null where id = s;
  set local session_replication_role = origin;
  for v in select uid, who from (values (owner1, 'OWNER'), (admin1, 'ADMIN')) as x(uid, who) loop
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', v.uid, 'role', 'authenticated')::text, true);
    for c in select clause from unnest(array[
        'status = ''COMPLETED''',                                    -- same-status
        'status = ''PENDING''', 'status = ''PROCESSING''', 'status = ''FAILED''',
        'started_at = now()', 'started_at = null',
        'completed_at = now() + interval ''1 day''', 'completed_at = null',
        'error_message = ''tampered''', 'error_message = null',
        'status = ''FAILED'', completed_at = now(), error_message = ''x'''  -- everything at once
      ]) as clause
    loop
      caught := false;
      begin execute 'update public.repository_snapshots set ' || c.clause || ' where id = $1' using s;
      exception when insufficient_privilege then caught := true; end;
      assert caught, format('%s must not modify a COMPLETED snapshot (%s)', v.who, c.clause);
    end loop;
  end loop;
  reset role;
  select * into r from public.repository_snapshots where id = s;
  assert r.status = 'COMPLETED' and r.started_at = timestamptz '2026-01-01 10:00:00+00'
     and r.completed_at = timestamptz '2026-01-01 10:05:00+00' and r.error_message is null,
     'a COMPLETED snapshot is unchanged after every attempted update';
  -- Defense in depth: even a path that bypasses RLS (superuser) cannot reopen it, because of the lifecycle trigger.
  caught := false; begin update public.repository_snapshots set status = 'PENDING' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'trigger still rejects COMPLETED -> PENDING even when RLS is bypassed';
  caught := false; begin update public.repository_snapshots set status = 'FAILED' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'trigger still rejects COMPLETED -> FAILED even when RLS is bypassed';
  caught := false; begin update public.repository_snapshots set status = 'PROCESSING' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'trigger still rejects COMPLETED -> PROCESSING even when RLS is bypassed';
  -- The sealed row can still be deleted by OWNER/ADMIN (the only way to remove it), and an in-flight one still completes.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', admin1, 'role', 'authenticated')::text, true);
  delete from public.repository_snapshots where id = s; get diagnostics n = row_count;
  assert n = 1, 'ADMIN can still delete the sealed COMPLETED snapshot';
  -- An in-flight snapshot cannot be completed by a direct UPDATE (only by a signed manifest, see
  -- repository_manifest_lifecycle_rls.sql); a failed one is retried through begin_snapshot_ingestion.
  select id into s from public.create_repository_snapshot(repo_empty, repeat('3',40), 'main');
  select run_token into c from public.begin_snapshot_ingestion(s);
  caught := false; begin update public.repository_snapshots set status = 'COMPLETED', completed_at = now() where id = s; exception when insufficient_privilege then caught := true; end;
  assert caught, 'PROCESSING -> COMPLETED is not possible by a direct UPDATE';
  perform public.fail_snapshot_ingestion(s, c.run_token, 'boom');
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  perform public.begin_snapshot_ingestion(s);
  select status, error_message into r from public.repository_snapshots where id = s;
  assert r.status = 'PROCESSING' and r.error_message is null, 'FAILED -> PENDING -> PROCESSING retry works through begin_snapshot_ingestion';

  ---------------------------------------------------------------- FILES: create, validation, uniqueness
  -- OWNER/ADMIN have no direct INSERT; the table rules below hold for every writer, so they run as superuser.
  for v in select uid, who from (values (owner1,'OWNER'),(admin1,'ADMIN')) as x(uid, who) loop
    perform set_config('request.jwt.claims', json_build_object('sub',v.uid,'role','authenticated')::text, true);
    caught := false;
    begin insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'src/direct.ts','TypeScript',1,h1); exception when insufficient_privilege then caught := true; end;
    assert caught, v.who || ' must not insert manifest rows directly';
  end loop;
  reset role;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'src/app/page.tsx','TypeScript',1234,h1) returning id into f;
  select * into r from public.repository_files where id = f;
  assert r.content_hash = h1 and r.size_bytes = 1234 and r.language = 'TypeScript' and r.path = 'src/app/page.tsx' and r.created_at is not null, 'valid file stored with hash and size';
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a,'README.md','Markdown',0,h2);
  insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a,'LICENSE',9999999999,h1);
  select * into r from public.repository_files where snapshot_id = s_a and path = 'README.md';
  assert r.size_bytes = 0, 'zero size allowed';
  select * into r from public.repository_files where snapshot_id = s_a and path = 'LICENSE';
  assert r.language is null and r.size_bytes = 9999999999, 'unknown language stored as NULL; large sizes (bigint) allowed';
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a2,'src/app/page.tsx','TypeScript',1300,h2);
  select count(*) into n from public.repository_files where path = 'src/app/page.tsx' and snapshot_id in (s_a, s_a2);
  assert n = 2, 'the same path may exist once in each of several snapshots';
  caught := false;
  begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a,'src/app/page.tsx',1,h1); exception when unique_violation then caught := true; end;
  assert caught, 'duplicate path within one snapshot rejected';
  select count(*) into n from public.repository_files where snapshot_id = s_a; assert n = 4, 'multiple files per snapshot (incl. fixture), saw ' || n;
  -- change detection: same path, same hash across snapshots = unchanged; different hash = changed
  select count(*) into n from public.repository_files a join public.repository_files b on a.path = b.path and a.snapshot_id = s_a and b.snapshot_id = s_a2 where a.content_hash = b.content_hash;
  assert n = 0, 'a path whose hash differs between snapshots is detectable as changed';

  for v in select p from unnest(array[
      '/etc/passwd', '/abs/path.ts', 'C:/Windows/x.ts', 'c:\Windows\x.ts', '\\server\share\x', '\abs.ts',
      '../secret.txt', 'a/../b.txt', 'a/b/..', '..', 'a\..\b.txt', '..\x.txt', './x.txt', 'a/./b.txt', '.', 'a/.',
      'trailing/', 'double//slash.ts', '', 'back\slash.ts',
      'ctl' || chr(1) || '.ts', 'tab' || chr(9) || '.ts', 'nl' || chr(10) || '.ts', 'cr' || chr(13) || '.ts', 'del' || chr(127) || '.ts',
      repeat('a', 1025)]) as p
  loop
    caught := false;
    begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2, v.p, 1, h1); exception when check_violation then caught := true; end;
    assert caught, format('path rejected: [%s]', left(encode(convert_to(v.p,'UTF8'),'escape'), 40));
  end loop;
  for v in select p from unnest(array['a.txt','src/a/b/c.ts','.gitignore','.github/workflows/ci.yml','dir.with.dots/file.name.ts','ünïcode/файл.ts','a b/c d.txt','...','a/...b','file..name']) as p loop
    insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2, v.p, 1, h1);
  end loop;
  select count(*) into n from public.repository_files where snapshot_id = s_a2 and path = 'ünïcode/файл.ts'; assert n = 1, 'unicode paths are allowed';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2,'neg.txt',-1,h1); exception when check_violation then caught := true; end;
  assert caught, 'negative size rejected';
  for v in select hh from unnest(array[upper(repeat('a',64)), repeat('1',63), repeat('1',65), repeat('g',64), '', 'sha256:' || h1, repeat('1',32)]) as hh loop
    caught := false;
    begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2,'hash.txt',1,v.hh); exception when check_violation then caught := true; end;
    assert caught, format('content_hash rejected: [%s]', left(v.hh, 20));
  end loop;
  caught := false; begin insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s_a2,'lang.txt','',1,h1); exception when check_violation then caught := true; end;
  assert caught, 'blank language rejected (must be NULL when unknown)';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes) values (s_a2,'nohash.txt',1); exception when not_null_violation or insufficient_privilege then caught := true; end;
  assert caught, 'content_hash is required';
  caught := false; begin insert into public.repository_files (path,size_bytes,content_hash) values ('orphan.txt',1,h1); exception when not_null_violation or insufficient_privilege then caught := true; end;
  assert caught, 'a file requires a snapshot';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values ('00000000-0000-0000-0000-00000000ffff','x.txt',1,h1); exception when foreign_key_violation then caught := true; end;
  assert caught, 'file must reference an existing snapshot (FK)';

  ---------------------------------------------------------------- FILES: roles, forged ids, visibility
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2,'member.txt',1,h1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not insert files';
  caught := false; begin delete from public.repository_files where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not delete files';
  select count(*) into n from public.repository_files where snapshot_id = s_a; assert n = 4, 'team MEMBER can read the file manifest';
  select count(*) into n from public.repository_files where id = f_b; assert n = 0, 'cross-team: team A member cannot see team B file';
  select count(*) into n from public.repository_files where id = f_bb; assert n = 0, 'cross-organization: org 1 member cannot see org 2 file';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.repository_files where snapshot_id in (s_a,s_a2); assert n = 0, 'team B member cannot see team A files';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2,'wrong-team.txt',1,h1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'cross-team: team B member must not insert files into a team A snapshot (forged snapshot id)';
  perform set_config('request.jwt.claims', json_build_object('sub',mdept,'role','authenticated')::text, true);
  select count(*) into n from public.repository_files; assert n = 0, 'same-department user with no team sees no files';
  perform set_config('request.jwt.claims', json_build_object('sub',mx,'role','authenticated')::text, true);
  select count(*) into n from public.repository_files; assert n = 0, 'non-team org member sees no files';
  perform set_config('request.jwt.claims', json_build_object('sub',mo,'role','authenticated')::text, true);
  select count(*) into n from public.repository_files; assert n = 0, 'other-department user sees no files';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.repository_files where snapshot_id in (s_a,s_a2,s_b); assert n = 0, 'other organization sees no org 1 files';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s_a2,'forged.txt',1,h1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged snapshot_id of another organization rejected (insert)';
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values ('00000000-0000-0000-0000-00000000ffff','forged.txt',1,h1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent snapshot_id rejected for clients';
  caught := false; begin delete from public.repository_files where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged file id: org 2 owner must not delete an org 1 file';
  caught := false; begin delete from public.repository_files where id = f_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged file id (fixture): org 2 owner must not delete an org 1 file';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  caught := false; begin delete from public.repository_files where id = f_bb; exception when insufficient_privilege then caught := true; end;
  assert caught, 'org 1 admin must not delete an org 2 file';
  reset role;
  select count(*) into n from public.repository_files where id in (f, f_a, f_bb); assert n = 3, 'no denied delete removed a file';
  set local role authenticated;

  ---------------------------------------------------------------- FILES: immutability (no update at all)
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false; begin update public.repository_files set snapshot_id = s_a2 where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'snapshot_id is immutable';
  caught := false; begin update public.repository_files set path = 'moved.ts' where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'path is immutable';
  caught := false; begin update public.repository_files set language = 'Python' where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'language is immutable';
  caught := false; begin update public.repository_files set size_bytes = 1 where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'size_bytes is immutable';
  caught := false; begin update public.repository_files set content_hash = h2 where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'content_hash is immutable';
  caught := false; begin update public.repository_files set created_at = now() where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'created_at is immutable';
  caught := false; begin update public.repository_files set id = gen_random_uuid() where id = f; exception when insufficient_privilege then caught := true; end;
  assert caught, 'file id is immutable';

  ---------------------------------------------------------------- FILES: no direct client write in any snapshot state; a COMPLETED manifest is sealed for every writer
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo_empty, repeat('8',40), 'main');
  reset role;
  insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'a.txt',1,h1) returning id into f;
  insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'b.txt',2,h2);
  for v in select st from unnest(array['PENDING','PROCESSING','FAILED','COMPLETED']) as st loop
    set local session_replication_role = replica;
    update public.repository_snapshots set status = v.st, started_at = now(), completed_at = case when v.st in ('COMPLETED','FAILED') then now() else null end where id = s;
    set local session_replication_role = origin;
    for c in select uid, who from (values (owner1,'OWNER'),(admin1,'ADMIN')) as x(uid, who) loop
      set local role authenticated;
      perform set_config('request.jwt.claims', json_build_object('sub',c.uid,'role','authenticated')::text, true);
      caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'late.txt',1,h1); exception when insufficient_privilege then caught := true; end;
      assert caught, format('%s snapshot: %s direct insert denied', v.st, c.who);
      caught := false; begin delete from public.repository_files where id = f; exception when insufficient_privilege then caught := true; end;
      assert caught, format('%s snapshot: %s direct delete denied', v.st, c.who);
      reset role;
    end loop;
  end loop;
  select count(*) into n from public.repository_files where snapshot_id = s; assert n = 2, 'the manifest is unchanged by every denied write';
  -- s is COMPLETED now: the seal trigger refuses even a writer that bypasses grants and RLS.
  caught := false; begin insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'late.txt',1,h1); exception when check_violation then caught := true; end;
  assert caught, 'COMPLETED manifest is sealed: insert refused for every writer';
  caught := false; begin delete from public.repository_files where id = f; exception when check_violation then caught := true; end;
  assert caught, 'COMPLETED manifest is sealed: delete refused for every writer';
  caught := false; begin update public.repository_snapshots set status = 'PENDING' where id = s; exception when check_violation then caught := true; end;
  assert caught, 'COMPLETED is terminal: it cannot be reopened to ingest again';
  select status into r from public.repository_snapshots where id = s;
  assert r.status = 'COMPLETED', 'COMPLETED snapshot stays COMPLETED';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);

  ---------------------------------------------------------------- snapshot isolation
  select count(*) into n from public.repository_files where snapshot_id = s_a and path = 'src/index.ts'; assert n = 1, 'snapshot A has its own file';
  select count(*) into n from public.repository_files where snapshot_id = s_a2 and path = 'src/index.ts'; assert n = 0, 'snapshot isolation: snapshot A2 does not see snapshot A files';

  ---------------------------------------------------------------- access follows team membership
  reset role;
  delete from public.team_members where team_id = team_a and user_id = ma;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshots; assert n = 0, 'leaving the team removes snapshot visibility';
  select count(*) into n from public.repository_files; assert n = 0, 'leaving the team removes file visibility';
  reset role;
  insert into public.team_members (team_id,user_id) values (team_a,ma);

  ---------------------------------------------------------------- deletes + cascades
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo_empty, repeat('6',40), 'main');
  reset role;
  insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'x.txt',1,h1),(s,'y.txt',1,h1);
  set local role authenticated;
  delete from public.repository_snapshots where id = s; get diagnostics n = row_count;
  assert n = 1, 'OWNER deletes snapshot';
  select count(*) into n from public.repository_files where snapshot_id = s; assert n = 0, 'deleting a snapshot cascades to its files';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo_empty, repeat('5',40), 'main');
  delete from public.repository_snapshots where id = s; get diagnostics n = row_count; assert n = 1, 'ADMIN deletes snapshot';
  -- a COMPLETED snapshot (frozen manifest) can still be deleted as a whole
  select id into s from public.create_repository_snapshot(repo_empty, repeat('4',40), 'main');
  reset role;
  insert into public.repository_files (snapshot_id,path,size_bytes,content_hash) values (s,'x.txt',1,h1);
  update public.repository_snapshots set status = 'PROCESSING', started_at = now() where id = s;
  update public.repository_snapshots set status = 'COMPLETED', completed_at = now() where id = s;
  set local role authenticated;
  delete from public.repository_snapshots where id = s; get diagnostics n = row_count; assert n = 1, 'a COMPLETED snapshot can be deleted by OWNER/ADMIN';
  select count(*) into n from public.repository_files where snapshot_id = s; assert n = 0, '...and its frozen manifest cascades with it';

  reset role;
  select count(*) into n from public.repository_snapshots where repository_id = repo_a; assert n > 0, 'cascade setup (repository has snapshots)';
  delete from public.repositories where id = repo_a;
  select count(*) into n from public.repository_snapshots where repository_id = repo_a; assert n = 0, 'deleting a repository cascades to its snapshots';
  select count(*) into n from public.repository_files where snapshot_id in (s_a, s_a2); assert n = 0, '...and to their files';
  select count(*) into n from public.repository_snapshots where id = s_b; assert n = 1, 'other repositories untouched';
  delete from public.projects where id = p_b;
  select count(*) into n from public.repository_snapshots where id = s_b; assert n = 0, 'deleting a project cascades through its repository to snapshots';
  select count(*) into n from public.repository_files where id = f_b; assert n = 0, '...and files';
  delete from public.teams where id = team_bb;
  select count(*) into n from public.repository_snapshots where id = s_bb; assert n = 0, 'deleting a team cascades down to snapshots';
  select count(*) into n from public.repository_files where id = f_bb; assert n = 0, '...and files';
  delete from public.organizations where id = org1;
  select count(*) into n from public.repository_snapshots; assert n = 0, 'deleting an organization cascades all the way to snapshots';
  select count(*) into n from public.repository_files; assert n = 0, '...and files';

  raise notice 'ALL SNAPSHOT AND FILE CHECKS PASSED';
end;
$$;

rollback;
