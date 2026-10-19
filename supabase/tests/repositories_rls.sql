-- Phase 2F authorization, isolation, integrity and lifecycle checks for repositories.
-- One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repositories_rls.sql

begin;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-000000000c01';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-000000000c02';  -- ADMIN of org 1 (in no team)
  ma     uuid := '00000000-0000-0000-0000-000000000c03';  -- MEMBER, dept 1, team A
  mb     uuid := '00000000-0000-0000-0000-000000000c04';  -- MEMBER, dept 1, team B   (same dept, different team)
  mdept  uuid := '00000000-0000-0000-0000-000000000c05';  -- MEMBER, dept 1, NO team
  mx     uuid := '00000000-0000-0000-0000-000000000c06';  -- MEMBER of org 1, no dept, no team
  mo     uuid := '00000000-0000-0000-0000-000000000c07';  -- MEMBER, dept 2, team C   (other department)
  owner2 uuid := '00000000-0000-0000-0000-000000000d01';  -- OWNER of org 2 (other tenant)
  m2     uuid := '00000000-0000-0000-0000-000000000d02';  -- MEMBER of org 2, team BB
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; deptb uuid;
  team_a uuid; team_b uuid; team_c uuid; team_bb uuid;
  p_a uuid; p_a2 uuid; p_b uuid; p_bb uuid; p_c uuid;       -- projects
  rp_a uuid; rp_b uuid; rp_bb uuid; rp uuid;                -- repositories
  r record; v record; n int; caught boolean;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values
    (owner1,'o1@g.local'),(admin1,'a1@g.local'),(ma,'ma@g.local'),(mb,'mb@g.local'),(mdept,'md@g.local'),
    (mx,'mx@g.local'),(mo,'mo@g.local'),(owner2,'o2@g.local'),(m2,'m2@g.local');
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
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'Payments','payments','GREENFIELD',owner1) returning id into p_a;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'Ledger','ledger','BROWNFIELD',owner1) returning id into p_a2;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_b,'Hiring','hiring','GREENFIELD',owner1) returning id into p_b;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_bb,'Payments','payments','BROWNFIELD',owner2) returning id into p_bb;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'Spare','spare','GREENFIELD',owner1) returning id into p_c;

  ---------------------------------------------------------------- anonymous denied
  set local role anon;
  caught := false; begin perform count(*) from public.repositories; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read repositories';
  caught := false;
  begin perform public.create_repository(p_a,'GITHUB','https://github.com/acme/payments','acme','payments','main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not create repositories (RPC)';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_a,'GITHUB','https://github.com/acme/payments','acme','payments','main',owner1);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not insert repositories directly';
  reset role;

  ---------------------------------------------------------------- create: roles, defaults, forged ids
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select * into r from public.create_repository(p_a,'GITHUB','  https://github.com/acme/payments  ',' acme ',' payments ','trunk','PRIVATE');
  rp_a := r.id;
  assert r.status = 'PENDING', 'new repository is always PENDING';
  assert r.default_branch = 'trunk', 'default branch is stored as given, never assumed to be main';
  assert r.repository_url = 'https://github.com/acme/payments' and r.owner = 'acme' and r.name = 'payments', 'inputs are trimmed';
  assert r.visibility = 'PRIVATE' and r.provider = 'GITHUB' and r.project_id = p_a, 'repository fields stored';
  select count(*) into n from public.repositories where id = rp_a and created_by = owner1; assert n = 1, 'created_by is the caller';
  select * into r from public.repositories where id = rp_a;
  assert r.created_at is not null and r.updated_at is not null, 'timestamps set';

  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select * into r from public.create_repository(p_b,'GITLAB','https://gitlab.com/acme/platform/hiring','acme/platform','hiring','develop');
  rp_b := r.id;
  assert r.visibility = 'UNKNOWN' and r.status = 'PENDING', 'ADMIN creates repository in a team they are not in; default visibility UNKNOWN';

  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false;
  begin perform public.create_repository(p_c,'GITHUB','https://github.com/acme/x','acme','x','main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create repositories (RPC)';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/acme/x','acme','x','main',ma);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create repositories (direct INSERT)';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  caught := false;
  begin perform public.create_repository(p_c,'GITHUB','https://github.com/acme/x','acme','x','main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'wrong-team MEMBER must not create a repository for another team project';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  caught := false;
  begin perform public.create_repository(p_c,'GITHUB','https://github.com/acme/x','acme','x','main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged project_id of another organization rejected (RPC)';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/acme/x','acme','x','main',owner2);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged project_id of another organization rejected (direct INSERT)';
  caught := false;
  begin perform public.create_repository('00000000-0000-0000-0000-00000000ffff','GITHUB','https://github.com/acme/x','acme','x','main'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent project_id rejected for clients';
  select * into r from public.create_repository(p_bb,'GITHUB','https://github.com/globex/payments','globex','payments','main');
  rp_bb := r.id;  -- positive control: org 2 owner connects own project, same repo name as org 1 is fine

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/acme/x','acme','x','main',admin1);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged created_by rejected';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,status,created_by)
        values (p_c,'GITHUB','https://github.com/acme/x','acme','x','main','CONNECTED',owner1);
  exception when insufficient_privilege then caught := true; end;
  assert caught, 'a repository cannot be created directly as CONNECTED';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/acme/x','acme','x','main',owner1) returning id into rp;
  exception when insufficient_privilege then caught := true; end;
  assert not caught, 'a plain direct insert as OWNER (defaults to PENDING) is allowed';
  delete from public.repositories where id = rp;

  ---------------------------------------------------------------- one repository per project
  caught := false;
  begin perform public.create_repository(p_a,'GITHUB','https://github.com/acme/other','acme','other','main'); exception when unique_violation then caught := true; end;
  assert caught, 'second repository for the same project rejected (RPC)';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_a,'GITLAB','https://gitlab.com/acme/other','acme','other','main',owner1);
  exception when unique_violation then caught := true; end;
  assert caught, 'second repository for the same project rejected (direct INSERT)';
  select count(*) into n from public.repositories where project_id = p_a; assert n = 1, 'still exactly one repository for the project';

  ---------------------------------------------------------------- value validation (as superuser: CHECK constraints)
  reset role;
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'SVN','https://x.example/a/b','a','b','main',owner1); exception when check_violation then caught := true; end;
  assert caught, 'invalid provider rejected';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,visibility,created_by)
        values (p_c,'GITHUB','https://github.com/a/b','a','b','main','SECRET',owner1); exception when check_violation then caught := true; end;
  assert caught, 'invalid visibility rejected';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,status,created_by)
        values (p_c,'GITHUB','https://github.com/a/b','a','b','main','DONE',owner1); exception when check_violation then caught := true; end;
  assert caught, 'invalid status rejected';
  for v in
    select u as bad_url from unnest(array[
      'http://github.com/a/b',                       -- not https
      'https://user:ghp_secrettoken@github.com/a/b', -- embedded credentials
      'https://ghp_secrettoken@github.com/a/b',      -- embedded token as userinfo
      'https://github.com/a/b?token=abc',            -- query string
      'https://github.com/a/b#frag',                 -- fragment
      'https://github.com/a b',                      -- whitespace
      'git@github.com:a/b.git',                      -- scp-style, not a URL
      'ssh://github.com/a/b',                        -- other scheme
      'javascript:alert(1)',                         -- other scheme
      'not a url',
      '',
      'https://' || repeat('a', 2050) || '.com/x/y'  -- too long
    ]) as u
  loop
    caught := false;
    begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
          values (p_c,'GENERIC_GIT',v.bad_url,'a','b','main',owner1); exception when check_violation then caught := true; end;
    assert caught, format('repository_url rejected: %s', left(v.bad_url, 40));
  end loop;
  for v in select u as ok_url from unnest(array[
      'https://github.com/acme/payments', 'https://gitlab.com/acme/platform/hiring', 'https://bitbucket.org/acme/x',
      'https://git.example.com/a/b.git', 'https://git.example.com:8443/a/b', 'https://github.com']) as u
  loop
    begin
      insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GENERIC_GIT',v.ok_url,'a','b','main',owner1);
      delete from public.repositories where project_id = p_c;
    exception when others then raise exception 'valid URL wrongly rejected: %', v.ok_url;
    end;
  end loop;
  for v in select * from (values
      ('owner blank',''),('owner space','a b'),('owner symbol','a$b')) as x(label, o)
  loop
    caught := false;
    begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
          values (p_c,'GITHUB','https://github.com/a/b',v.o,'b','main',owner1); exception when check_violation then caught := true; end;
    assert caught, format('%s rejected', v.label);
  end loop;
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/a/b','a','b/c','main',owner1); exception when check_violation then caught := true; end;
  assert caught, 'repository name may not contain a slash';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values (p_c,'GITHUB','https://github.com/a/b',repeat('a',101),'b','main',owner1); exception when check_violation then caught := true; end;
  assert caught, 'owner over 100 chars rejected';
  for v in select b from unnest(array['', 'my branch', 'a~b', 'a^b', 'a:b', 'a?b', 'a*b', 'a[b', 'a\b', '-flag', 'a..b', repeat('x',256)]) as b loop
    caught := false;
    begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
          values (p_c,'GITHUB','https://github.com/a/b','a','b',v.b,owner1); exception when check_violation then caught := true; end;
    assert caught, format('default_branch rejected: [%s]', left(v.b, 20));
  end loop;
  for v in select b from unnest(array['main','master','trunk','develop','release/1.2','feature/x_y-z','v1.0']) as b loop
    insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
      values (p_c,'GITHUB','https://github.com/a/b','a','b',v.b,owner1);
    delete from public.repositories where project_id = p_c;
  end loop;
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,created_by)
        values (p_c,'GITHUB','https://github.com/a/b','a','b',owner1); exception when not_null_violation then caught := true; end;
  assert caught, 'default_branch is required (no silent "main")';
  caught := false;
  begin insert into public.repositories (provider,repository_url,owner,name,default_branch,created_by)
        values ('GITHUB','https://github.com/a/b','a','b','main',owner1); exception when not_null_violation then caught := true; end;
  assert caught, 'repository requires a project';
  caught := false;
  begin insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by)
        values ('00000000-0000-0000-0000-00000000ffff','GITHUB','https://github.com/a/b','a','b','main',owner1); exception when foreign_key_violation then caught := true; end;
  assert caught, 'repository must reference an existing project (FK)';

  ---------------------------------------------------------------- visibility
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id in (rp_a,rp_b); assert n = 2, 'OWNER sees all org 1 repositories';
  select count(*) into n from public.repositories where id = rp_bb; assert n = 0, 'OWNER cannot see org 2 repository';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id in (rp_a,rp_b); assert n = 2, 'ADMIN sees all org 1 repositories, even in no team';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id = rp_a; assert n = 1, 'team A MEMBER can view their project repository';
  select count(*) into n from public.repositories where id = rp_b; assert n = 0, 'cross-project: team A member cannot see team B repository';
  select count(*) into n from public.repositories; assert n = 1, 'team A member sees only permitted repositories, saw ' || n;
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id = rp_a; assert n = 0, 'team B member cannot see team A repository (same department)';
  select count(*) into n from public.repositories where id = rp_b; assert n = 1, 'team B member sees own project repository';
  perform set_config('request.jwt.claims', json_build_object('sub',mdept,'role','authenticated')::text, true);
  select count(*) into n from public.repositories; assert n = 0, 'same-department user with no team sees no repositories';
  perform set_config('request.jwt.claims', json_build_object('sub',mx,'role','authenticated')::text, true);
  select count(*) into n from public.repositories; assert n = 0, 'non-team org member sees no repositories';
  perform set_config('request.jwt.claims', json_build_object('sub',mo,'role','authenticated')::text, true);
  select count(*) into n from public.repositories; assert n = 0, 'other-department user sees no repositories';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id in (rp_a,rp_b); assert n = 0, 'other organization sees no org 1 repositories';
  select count(*) into n from public.repositories; assert n = 1, 'org 2 owner sees only org 2 repositories';
  perform set_config('request.jwt.claims', json_build_object('sub',m2,'role','authenticated')::text, true);
  select count(*) into n from public.repositories where id = rp_bb; assert n = 1, 'org 2 team member sees own repository';

  ---------------------------------------------------------------- update by role, cross-tenant
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  update public.repositories set default_branch = 'release', visibility = 'INTERNAL' where id = rp_a;
  get diagnostics n = row_count; assert n = 1, 'OWNER updates default_branch and visibility';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  update public.repositories set visibility = 'PUBLIC' where id = rp_b;
  get diagnostics n = row_count; assert n = 1, 'ADMIN updates repository in a team they are not in';
  update public.repositories set visibility = 'PUBLIC' where id = rp_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not update org 2 repository';
  delete from public.repositories where id = rp_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not delete org 2 repository';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  update public.repositories set default_branch = 'hacked' where id = rp_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER (can read) must not update repository';
  update public.repositories set status = 'CONNECTED' where id = rp_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not change repository status';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  update public.repositories set default_branch = 'hacked' where id = rp_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not update repository';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  update public.repositories set default_branch = 'hacked' where id = rp_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not update org 1 repository';

  ---------------------------------------------------------------- immutable fields
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false; begin update public.repositories set project_id = p_c where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'project_id (same team, free project) is immutable: no transfer';
  caught := false; begin update public.repositories set project_id = p_bb where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'project_id (other organization) is immutable';
  caught := false; begin update public.repositories set created_by = admin1 where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'created_by is immutable';
  caught := false; begin update public.repositories set created_at = now() - interval '1 day' where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'created_at is immutable';
  caught := false; begin update public.repositories set id = gen_random_uuid() where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'id is immutable';
  caught := false; begin update public.repositories set repository_url = 'https://github.com/evil/repo' where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'repository_url is immutable (disconnect and reconnect to change identity)';
  caught := false; begin update public.repositories set owner = 'evil' where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'owner is immutable';
  caught := false; begin update public.repositories set name = 'evil' where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'name is immutable';
  caught := false; begin update public.repositories set provider = 'GITLAB' where id = rp_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'provider is immutable';
  caught := false; begin update public.repositories set visibility = 'SECRET' where id = rp_a; exception when check_violation then caught := true; end;
  assert caught, 'invalid visibility rejected on update';
  caught := false; begin update public.repositories set default_branch = 'bad branch' where id = rp_a; exception when check_violation then caught := true; end;
  assert caught, 'invalid default_branch rejected on update';

  ---------------------------------------------------------------- lifecycle: every (from, to) pair
  select id into rp from public.create_repository(p_c,'GITHUB','https://github.com/acme/lifecycle','acme','lifecycle','main');
  for v in
    select f, t, ok from (values
      ('PENDING','PENDING',true),('PENDING','CONNECTED',true),('PENDING','DISCONNECTED',false),('PENDING','ERROR',true),
      ('CONNECTED','PENDING',false),('CONNECTED','CONNECTED',true),('CONNECTED','DISCONNECTED',true),('CONNECTED','ERROR',true),
      ('DISCONNECTED','PENDING',true),('DISCONNECTED','CONNECTED',false),('DISCONNECTED','DISCONNECTED',true),('DISCONNECTED','ERROR',false),
      ('ERROR','PENDING',true),('ERROR','CONNECTED',false),('ERROR','DISCONNECTED',false),('ERROR','ERROR',true)
    ) as x(f, t, ok)
  loop
    reset role;                                              -- force the starting state, bypassing the trigger
    set local session_replication_role = replica;
    update public.repositories set status = v.f where id = rp;
    set local session_replication_role = origin;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
    caught := false;
    begin update public.repositories set status = v.t where id = rp; exception when check_violation then caught := true; end;
    assert caught = not v.ok, format('repository transition %s -> %s: expected %s', v.f, v.t, case when v.ok then 'allowed' else 'rejected' end);
    select status into r from public.repositories where id = rp;
    assert r.status = case when v.ok then v.t else v.f end, format('repository %s -> %s left wrong status %s', v.f, v.t, r.status);
  end loop;
  caught := false; begin update public.repositories set status = 'DONE' where id = rp; exception when check_violation then caught := true; end;
  assert caught, 'unknown status rejected on update';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  reset role; set local session_replication_role = replica; update public.repositories set status = 'PENDING' where id = rp; set local session_replication_role = origin;
  set local role authenticated; perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  update public.repositories set status = 'CONNECTED' where id = rp;
  get diagnostics n = row_count; assert n = 1, 'ADMIN can change status along an allowed transition';

  ---------------------------------------------------------------- delete (disconnect) by role
  select id into rp from public.create_repository(p_a2,'BITBUCKET','https://bitbucket.org/acme/ledger','acme','ledger','main');
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  delete from public.repositories where id = rp;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not delete repository';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  delete from public.repositories where id = rp;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not delete repository';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  delete from public.repositories where id = rp;
  get diagnostics n = row_count; assert n = 0, 'other organization must not delete repository';
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  delete from public.repositories where id = rp;
  get diagnostics n = row_count; assert n = 1, 'OWNER deletes (disconnects) repository';
  select id into rp from public.create_repository(p_a2,'GENERIC_GIT','https://git.example.com/acme/ledger.git','acme','ledger','main');
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  delete from public.repositories where id = rp;
  get diagnostics n = row_count; assert n = 1, 'ADMIN deletes (disconnects) repository';
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select * into r from public.create_repository(p_a2,'GITHUB','https://github.com/acme/ledger-v2','acme','ledger-v2','main');
  assert r.status = 'PENDING', 'after disconnect the project can connect a new repository';

  ---------------------------------------------------------------- access follows team membership
  reset role;
  delete from public.team_members where team_id = team_a and user_id = ma;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.repositories; assert n = 0, 'leaving the team removes repository visibility';
  reset role;
  insert into public.team_members (team_id,user_id) values (team_a,ma);

  ---------------------------------------------------------------- cascades
  select count(*) into n from public.repositories where project_id = p_a; assert n = 1, 'cascade setup (project has a repository)';
  delete from public.projects where id = p_a;
  select count(*) into n from public.repositories where project_id = p_a; assert n = 0, 'deleting a project cascades to its repository';
  select count(*) into n from public.repositories where id = rp_b; assert n = 1, 'other projects untouched';
  delete from public.teams where id = team_b;
  select count(*) into n from public.repositories where id = rp_b; assert n = 0, 'deleting a team cascades through projects to repositories';
  select count(*) into n from public.repositories where project_id = p_a2; assert n = 1, 'repository of a surviving project untouched';
  delete from public.departments where id = dept1;
  select count(*) into n from public.repositories where project_id = p_a2; assert n = 0, 'deleting a department cascades down to repositories';
  select count(*) into n from public.repositories where id = rp_bb; assert n = 1, 'other organization untouched by cascade';
  delete from public.organizations where id = org2;
  -- Only this suite's repositories: the local database may hold real ones.
  select count(*) into n from public.repositories where created_by in (owner1, admin1, ma, mb, mdept, mx, mo, owner2, m2);
  assert n = 0, 'deleting an organization cascades all the way to repositories';

  raise notice 'ALL REPOSITORY CHECKS PASSED';
end;
$$;

rollback;
