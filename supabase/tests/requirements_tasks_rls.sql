-- Phase 2E authorization, isolation, integrity and lifecycle checks for requirements and tasks.
-- One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/requirements_tasks_rls.sql

begin;

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
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; deptb uuid;
  team_a uuid; team_b uuid; team_c uuid; team_bb uuid;
  p_a uuid; p_a2 uuid; p_b uuid; p_bb uuid;                 -- projects
  rq_a uuid; rq_a2 uuid; rq_b uuid; rq_bb uuid; rq uuid;    -- requirements
  tk_a uuid; tk_a2 uuid; tk_b uuid; tk_bb uuid; tk uuid;    -- tasks
  r record; v record; n int; caught boolean;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values
    (owner1,'o1@r.local'),(admin1,'a1@r.local'),(ma,'ma@r.local'),(mb,'mb@r.local'),(mdept,'md@r.local'),
    (mx,'mx@r.local'),(mo,'mo@r.local'),(owner2,'o2@r.local'),(m2,'m2@r.local');
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
  insert into public.requirements (project_id,title,created_by) values (p_a,'Req A',owner1) returning id into rq_a;
  insert into public.requirements (project_id,title,created_by) values (p_a2,'Req A2',owner1) returning id into rq_a2;
  insert into public.requirements (project_id,title,created_by) values (p_b,'Req B',owner1) returning id into rq_b;
  insert into public.requirements (project_id,title,created_by) values (p_bb,'Req BB',owner2) returning id into rq_bb;
  insert into public.tasks (requirement_id,title,created_by) values (rq_a,'Task A',owner1) returning id into tk_a;
  insert into public.tasks (requirement_id,title,created_by) values (rq_a2,'Task A2',owner1) returning id into tk_a2;
  insert into public.tasks (requirement_id,title,created_by) values (rq_b,'Task B',owner1) returning id into tk_b;
  insert into public.tasks (requirement_id,title,created_by) values (rq_bb,'Task BB',owner2) returning id into tk_bb;

  -- Defaults (superuser insert above used none of status/priority) ------------
  select * into r from public.requirements where id = rq_a;
  assert r.status = 'DRAFT' and r.priority = 'MEDIUM' and r.description is null, 'requirement defaults: DRAFT / MEDIUM / no description';
  assert r.created_at is not null and r.updated_at is not null, 'requirement timestamps set';
  select * into r from public.tasks where id = tk_a;
  assert r.status = 'TODO' and r.priority = 'MEDIUM', 'task defaults: TODO / MEDIUM';

  ---------------------------------------------------------------- anonymous denied
  set local role anon;
  caught := false; begin perform count(*) from public.requirements; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read requirements';
  caught := false; begin perform count(*) from public.tasks; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read tasks';
  caught := false; begin perform public.create_requirement(p_a, 'Anon'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not create requirements (RPC)';
  caught := false; begin perform public.create_task(rq_a, 'Anon'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not create tasks (RPC)';
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values (p_a,'Anon',owner1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not insert requirements directly';
  reset role;

  ---------------------------------------------------------------- REQUIREMENTS: create
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select * into r from public.create_requirement(p_a, '  Users can pay by card  ', 'Card payments', 'HIGH');
  rq := r.id;
  assert r.title = 'Users can pay by card' and r.status = 'DRAFT' and r.priority = 'HIGH' and r.project_id = p_a, 'OWNER creates requirement (trimmed, DRAFT)';
  select count(*) into n from public.requirements where id = rq and created_by = owner1;
  assert n = 1, 'requirement created_by is the caller';
  select * into r from public.create_requirement(p_a, 'No description given');
  assert r.description is null and r.priority = 'MEDIUM', 'defaults apply through the RPC (NULL description, MEDIUM)';

  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select * into r from public.create_requirement(p_b, 'Hiring pipeline', null, 'LOW');
  assert r.project_id = p_b, 'ADMIN creates requirement in a project of a team they are not in';

  caught := false; begin perform public.create_requirement(p_a, '   '); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'blank requirement title rejected';
  caught := false; begin perform public.create_requirement(p_a, repeat('x',201)); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'requirement title over 200 chars rejected';
  caught := false; begin perform public.create_requirement(p_a, 'Bad priority', null, 'URGENT'); exception when check_violation then caught := true; end;
  assert caught, 'invalid requirement priority rejected';
  caught := false; begin perform public.create_requirement(p_a, 'Long desc', repeat('x',2001)); exception when check_violation then caught := true; end;
  assert caught, 'requirement description over 2000 chars rejected';

  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false; begin perform public.create_requirement(p_a, 'Member req'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create requirements (RPC)';
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values (p_a,'Member req',ma); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create requirements (direct INSERT)';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  caught := false; begin perform public.create_requirement(p_a, 'Wrong team'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'wrong-team MEMBER must not create requirements in team A project';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  caught := false; begin perform public.create_requirement(p_a, 'Forged project'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged project_id of another organization rejected (RPC)';
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values (p_a,'Forged',owner2); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged project_id of another organization rejected (direct INSERT)';
  caught := false; begin perform public.create_requirement('00000000-0000-0000-0000-00000000ffff', 'Ghost'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent project_id rejected for clients';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values (p_a,'Forged author',admin1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged created_by rejected';
  caught := false;
  begin insert into public.requirements (project_id,title,status,created_by) values (p_a,'Born ready','READY',owner1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirements can only be inserted as DRAFT';
  reset role;
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values ('00000000-0000-0000-0000-00000000ffff','X',owner1); exception when foreign_key_violation then caught := true; end;
  assert caught, 'requirement must reference an existing project (FK)';
  caught := false;
  begin insert into public.requirements (project_id,title,status,created_by) values (p_a,'S','DONE',owner1); exception when check_violation then caught := true; end;
  assert caught, 'invalid requirement status rejected by CHECK';
  caught := false;
  begin insert into public.requirements (project_id,title,created_by) values (p_a,'   ',owner1); exception when check_violation then caught := true; end;
  assert caught, 'blank requirement title rejected by CHECK';
  caught := false;
  begin insert into public.requirements (project_id,created_by) values (p_a,owner1); exception when not_null_violation then caught := true; end;
  assert caught, 'requirement title is required';

  ---------------------------------------------------------------- REQUIREMENTS: visibility
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id in (rq_a,rq_a2,rq_b); assert n = 3, 'OWNER sees all org 1 requirements';
  select count(*) into n from public.requirements where id = rq_bb; assert n = 0, 'OWNER cannot see org 2 requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id in (rq_a,rq_a2,rq_b); assert n = 3, 'ADMIN sees all org 1 requirements even in no team';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id in (rq_a,rq_a2); assert n = 2, 'team A member sees requirements of both team A projects';
  select count(*) into n from public.requirements where id = rq_b; assert n = 0, 'team A member cannot see team B project requirements';
  select count(*) into n from public.requirements where id = rq_bb; assert n = 0, 'org 1 member cannot see org 2 requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id in (rq_a,rq_a2); assert n = 0, 'cross-team: team B member cannot see team A requirements (same dept)';
  select count(*) into n from public.requirements where id = rq_b; assert n = 1, 'team B member sees own project requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',mdept,'role','authenticated')::text, true);
  select count(*) into n from public.requirements; assert n = 0, 'same-department user with no team sees no requirements';
  perform set_config('request.jwt.claims', json_build_object('sub',mx,'role','authenticated')::text, true);
  select count(*) into n from public.requirements; assert n = 0, 'same-org user with no department sees no requirements';
  perform set_config('request.jwt.claims', json_build_object('sub',mo,'role','authenticated')::text, true);
  select count(*) into n from public.requirements; assert n = 0, 'cross-department: other-department member sees no requirements';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id in (rq_a,rq_a2,rq_b); assert n = 0, 'cross-organization: org 2 owner sees no org 1 requirements';
  select count(*) into n from public.requirements; assert n = 1, 'org 2 owner sees only org 2 requirements';
  perform set_config('request.jwt.claims', json_build_object('sub',m2,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where id = rq_bb; assert n = 1, 'org 2 team member sees own requirement';

  ---------------------------------------------------------------- REQUIREMENTS: update / immutability / delete
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  update public.requirements set title = 'Req A (owner)', priority = 'CRITICAL', description = 'edited' where id = rq_a;
  get diagnostics n = row_count; assert n = 1, 'OWNER updates requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  update public.requirements set title = 'Req B (admin)' where id = rq_b;
  get diagnostics n = row_count; assert n = 1, 'ADMIN updates requirement in a team they are not in';
  update public.requirements set title = 'Hijack' where id = rq_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not update org 2 requirement';
  delete from public.requirements where id = rq_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not delete org 2 requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  update public.requirements set title = 'Member edit' where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER (can read) must not update requirement';
  update public.requirements set status = 'READY' where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not change requirement status';
  delete from public.requirements where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not delete requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  update public.requirements set title = 'Wrong team' where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not update requirement';
  delete from public.requirements where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not delete requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  update public.requirements set title = 'Org 2' where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not update org 1 requirement';
  delete from public.requirements where id = rq_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not delete org 1 requirement';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false; begin update public.requirements set project_id = p_a2 where id = rq_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'project_id (same team) is immutable';
  caught := false; begin update public.requirements set project_id = p_bb where id = rq_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'project_id (other organization) is immutable';
  caught := false; begin update public.requirements set created_by = admin1 where id = rq_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirement created_by is immutable';
  caught := false; begin update public.requirements set created_at = now() - interval '1 day' where id = rq_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirement created_at is immutable';
  caught := false; begin update public.requirements set id = gen_random_uuid() where id = rq_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirement id is immutable';

  ---------------------------------------------------------------- REQUIREMENTS: lifecycle, every (from, to) pair
  select id into rq from public.create_requirement(p_a, 'Lifecycle subject');
  for v in
    select f, t, ok from (values
      ('DRAFT','DRAFT',true),('DRAFT','READY',true),('DRAFT','IN_PROGRESS',false),('DRAFT','COMPLETED',false),('DRAFT','CANCELLED',true),
      ('READY','DRAFT',false),('READY','READY',true),('READY','IN_PROGRESS',true),('READY','COMPLETED',false),('READY','CANCELLED',true),
      ('IN_PROGRESS','DRAFT',false),('IN_PROGRESS','READY',false),('IN_PROGRESS','IN_PROGRESS',true),('IN_PROGRESS','COMPLETED',true),('IN_PROGRESS','CANCELLED',true),
      ('COMPLETED','DRAFT',false),('COMPLETED','READY',false),('COMPLETED','IN_PROGRESS',true),('COMPLETED','COMPLETED',true),('COMPLETED','CANCELLED',false),
      ('CANCELLED','DRAFT',true),('CANCELLED','READY',false),('CANCELLED','IN_PROGRESS',false),('CANCELLED','COMPLETED',false),('CANCELLED','CANCELLED',true)
    ) as x(f, t, ok)
  loop
    reset role;                                              -- force the starting state, bypassing the trigger
    set local session_replication_role = replica;
    update public.requirements set status = v.f where id = rq;
    set local session_replication_role = origin;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
    caught := false;
    begin update public.requirements set status = v.t where id = rq; exception when check_violation then caught := true; end;
    assert caught = not v.ok, format('requirement transition %s -> %s: expected %s', v.f, v.t, case when v.ok then 'allowed' else 'rejected' end);
    select status into r from public.requirements where id = rq;
    assert r.status = case when v.ok then v.t else v.f end, format('requirement %s -> %s left wrong status %s', v.f, v.t, r.status);
  end loop;
  caught := false; begin update public.requirements set status = 'DONE' where id = rq; exception when check_violation then caught := true; end;
  assert caught, 'unknown requirement status rejected on update';

  ---------------------------------------------------------------- TASKS: create
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select * into r from public.create_task(rq_a, '  Add card form  ', 'UI', 'HIGH');
  tk := r.id;
  assert r.title = 'Add card form' and r.status = 'TODO' and r.priority = 'HIGH' and r.requirement_id = rq_a, 'OWNER creates task (trimmed, TODO)';
  select count(*) into n from public.tasks where id = tk and created_by = owner1; assert n = 1, 'task created_by is the caller';
  select * into r from public.create_task(rq_a, 'Defaults');
  assert r.description is null and r.priority = 'MEDIUM', 'task defaults apply through the RPC';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select * into r from public.create_task(rq_b, 'Admin task', null, 'LOW');
  assert r.requirement_id = rq_b, 'ADMIN creates task under a requirement of a team they are not in';

  caught := false; begin perform public.create_task(rq_a, '   '); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'blank task title rejected';
  caught := false; begin perform public.create_task(rq_a, repeat('x',201)); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'task title over 200 chars rejected';
  caught := false; begin perform public.create_task(rq_a, 'Bad priority', null, 'URGENT'); exception when check_violation then caught := true; end;
  assert caught, 'invalid task priority rejected';
  caught := false; begin perform public.create_task(rq_a, 'Long', repeat('x',2001)); exception when check_violation then caught := true; end;
  assert caught, 'task description over 2000 chars rejected';

  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  caught := false; begin perform public.create_task(rq_a, 'Member task'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create tasks (RPC)';
  caught := false;
  begin insert into public.tasks (requirement_id,title,created_by) values (rq_a,'Member task',ma); exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not create tasks (direct INSERT)';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  caught := false; begin perform public.create_task(rq_a, 'Wrong team'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'wrong-team MEMBER must not create tasks under team A requirement';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  caught := false; begin perform public.create_task(rq_a, 'Forged requirement'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged requirement_id of another organization rejected (RPC)';
  caught := false;
  begin insert into public.tasks (requirement_id,title,created_by) values (rq_a,'Forged',owner2); exception when insufficient_privilege then caught := true; end;
  assert caught, 'forged requirement_id of another organization rejected (direct INSERT)';
  caught := false; begin perform public.create_task('00000000-0000-0000-0000-00000000ffff', 'Ghost'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nonexistent requirement_id rejected for clients';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false;
  begin insert into public.tasks (title,created_by) values ('Standalone',owner1); exception when insufficient_privilege or not_null_violation then caught := true; end;
  assert caught, 'task without a requirement rejected for clients';
  caught := false;
  begin insert into public.tasks (requirement_id,title,created_by) values (rq_a,'Forged author',admin1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'task forged created_by rejected';
  caught := false;
  begin insert into public.tasks (requirement_id,title,status,created_by) values (rq_a,'Born done','COMPLETED',owner1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'tasks can only be inserted as TODO';
  reset role;
  caught := false;
  begin insert into public.tasks (title,created_by) values ('Standalone',owner1); exception when not_null_violation then caught := true; end;
  assert caught, 'task without a requirement rejected by NOT NULL';
  caught := false;
  begin insert into public.tasks (requirement_id,title,created_by) values ('00000000-0000-0000-0000-00000000ffff','X',owner1); exception when foreign_key_violation then caught := true; end;
  assert caught, 'task must reference an existing requirement (FK)';
  caught := false;
  begin insert into public.tasks (requirement_id,title,status,created_by) values (rq_a,'S','ARCHIVED',owner1); exception when check_violation then caught := true; end;
  assert caught, 'invalid task status rejected by CHECK';
  caught := false;
  begin insert into public.tasks (requirement_id,title,created_by) values (rq_a,'  ',owner1); exception when check_violation then caught := true; end;
  assert caught, 'blank task title rejected by CHECK';

  ---------------------------------------------------------------- TASKS: visibility
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.tasks where id in (tk_a,tk_a2,tk_b); assert n = 3, 'OWNER sees all org 1 tasks';
  select count(*) into n from public.tasks where id = tk_bb; assert n = 0, 'OWNER cannot see org 2 task';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select count(*) into n from public.tasks where id in (tk_a,tk_a2,tk_b); assert n = 3, 'ADMIN sees all org 1 tasks';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.tasks where id in (tk_a,tk_a2); assert n = 2, 'team A member sees tasks under both team A projects (cross-requirement, cross-project, same team)';
  select count(*) into n from public.tasks where id = tk_b; assert n = 0, 'cross-team: team A member cannot see team B task';
  select count(*) into n from public.tasks where id = tk_bb; assert n = 0, 'cross-organization: org 1 member cannot see org 2 task';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.tasks where id in (tk_a,tk_a2); assert n = 0, 'team B member cannot see team A tasks';
  perform set_config('request.jwt.claims', json_build_object('sub',mdept,'role','authenticated')::text, true);
  select count(*) into n from public.tasks; assert n = 0, 'same-department user with no team sees no tasks';
  perform set_config('request.jwt.claims', json_build_object('sub',mx,'role','authenticated')::text, true);
  select count(*) into n from public.tasks; assert n = 0, 'same-org user with no department sees no tasks';
  perform set_config('request.jwt.claims', json_build_object('sub',mo,'role','authenticated')::text, true);
  select count(*) into n from public.tasks; assert n = 0, 'cross-department user sees no tasks';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.tasks where id in (tk_a,tk_a2,tk_b); assert n = 0, 'org 2 owner sees no org 1 tasks';
  select count(*) into n from public.tasks; assert n = 1, 'org 2 owner sees only org 2 tasks';

  ---------------------------------------------------------------- TASKS: update / immutability / delete
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  update public.tasks set title = 'Task A (owner)', priority = 'CRITICAL', description = 'edited' where id = tk_a;
  get diagnostics n = row_count; assert n = 1, 'OWNER updates task';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  update public.tasks set title = 'Task B (admin)' where id = tk_b;
  get diagnostics n = row_count; assert n = 1, 'ADMIN updates task in a team they are not in';
  update public.tasks set title = 'Hijack' where id = tk_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not update org 2 task';
  delete from public.tasks where id = tk_bb;
  get diagnostics n = row_count; assert n = 0, 'org 1 admin must not delete org 2 task';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  update public.tasks set title = 'Member edit' where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not update task';
  -- Since migration 20261024000001 status changes only through transition_task(): no client UPDATE on status.
  caught := false; begin update public.tasks set status = 'IN_PROGRESS' where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'team MEMBER must not change task status';
  delete from public.tasks where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'team MEMBER must not delete task';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  update public.tasks set title = 'Wrong team' where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not update task';
  delete from public.tasks where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'wrong-team MEMBER must not delete task';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  update public.tasks set title = 'Org 2' where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not update org 1 task';
  delete from public.tasks where id = tk_a;
  get diagnostics n = row_count; assert n = 0, 'org 2 owner must not delete org 1 task';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  caught := false; begin update public.tasks set requirement_id = rq_a2 where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirement_id (same team, other project) is immutable';
  caught := false; begin update public.tasks set requirement_id = rq_bb where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'requirement_id (other organization) is immutable';
  caught := false; begin update public.tasks set created_by = admin1 where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'task created_by is immutable';
  caught := false; begin update public.tasks set created_at = now() - interval '1 day' where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'task created_at is immutable';
  caught := false; begin update public.tasks set id = gen_random_uuid() where id = tk_a; exception when insufficient_privilege then caught := true; end;
  assert caught, 'task id is immutable';

  ---------------------------------------------------------------- TASKS: lifecycle, every (from, to) pair
  -- Since migration 20261024000001 clients (even OWNERs) change status only through transition_task(), which is tested
  -- with its actor rules in task_workflow_rls.sql. The lifecycle trigger itself is checked here for every pair.
  select id into tk from public.create_task(rq_a, 'Lifecycle task');
  caught := false; begin update public.tasks set status = 'IN_PROGRESS' where id = tk; exception when insufficient_privilege then caught := true; end;
  assert caught, 'OWNER cannot bypass transition_task() with a direct status update';
  reset role;
  for v in
    select f, t, ok from (values
      ('TODO','TODO',true),('TODO','IN_PROGRESS',true),('TODO','BLOCKED',false),('TODO','IN_REVIEW',false),('TODO','COMPLETED',false),('TODO','CANCELLED',true),
      ('IN_PROGRESS','TODO',true),('IN_PROGRESS','IN_PROGRESS',true),('IN_PROGRESS','BLOCKED',true),('IN_PROGRESS','IN_REVIEW',true),('IN_PROGRESS','COMPLETED',true),('IN_PROGRESS','CANCELLED',true),
      ('BLOCKED','TODO',false),('BLOCKED','IN_PROGRESS',true),('BLOCKED','BLOCKED',true),('BLOCKED','IN_REVIEW',false),('BLOCKED','COMPLETED',false),('BLOCKED','CANCELLED',true),
      ('IN_REVIEW','TODO',false),('IN_REVIEW','IN_PROGRESS',true),('IN_REVIEW','BLOCKED',false),('IN_REVIEW','IN_REVIEW',true),('IN_REVIEW','COMPLETED',true),('IN_REVIEW','CANCELLED',true),
      ('COMPLETED','TODO',false),('COMPLETED','IN_PROGRESS',true),('COMPLETED','BLOCKED',false),('COMPLETED','IN_REVIEW',false),('COMPLETED','COMPLETED',true),('COMPLETED','CANCELLED',false),
      ('CANCELLED','TODO',true),('CANCELLED','IN_PROGRESS',false),('CANCELLED','BLOCKED',false),('CANCELLED','IN_REVIEW',false),('CANCELLED','COMPLETED',false),('CANCELLED','CANCELLED',true)
    ) as x(f, t, ok)
  loop
    set local session_replication_role = replica;
    update public.tasks set status = v.f where id = tk;
    set local session_replication_role = origin;
    caught := false;
    begin update public.tasks set status = v.t where id = tk; exception when check_violation then caught := true; end;
    assert caught = not v.ok, format('task transition %s -> %s: expected %s', v.f, v.t, case when v.ok then 'allowed' else 'rejected' end);
    select status into r from public.tasks where id = tk;
    assert r.status = case when v.ok then v.t else v.f end, format('task %s -> %s left wrong status %s', v.f, v.t, r.status);
  end loop;
  caught := false; begin update public.tasks set status = 'ARCHIVED' where id = tk; exception when check_violation then caught := true; end;
  assert caught, 'unknown task status rejected on update';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);

  ---------------------------------------------------------------- access follows team membership (derived through project)
  reset role;
  delete from public.team_members where team_id = team_a and user_id = ma;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.requirements where project_id in (p_a,p_a2); assert n = 0, 'leaving the team removes requirement access';
  select count(*) into n from public.tasks where requirement_id in (rq_a,rq_a2); assert n = 0, 'leaving the team removes task access';
  reset role;
  insert into public.team_members (team_id,user_id) values (team_a,ma);

  ---------------------------------------------------------------- deletes + cascades
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select id into tk from public.create_task(rq_a2, 'Delete me task');
  delete from public.tasks where id = tk;
  get diagnostics n = row_count; assert n = 1, 'OWNER deletes task';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select id into tk from public.create_task(rq_a2, 'Delete me task 2');
  delete from public.tasks where id = tk;
  get diagnostics n = row_count; assert n = 1, 'ADMIN deletes task';

  select id into rq from public.create_requirement(p_a2, 'Cascade me');
  insert into public.tasks (requirement_id,title,created_by) values (rq,'Child 1',admin1),(rq,'Child 2',admin1);
  select count(*) into n from public.tasks where requirement_id = rq; assert n = 2, 'cascade setup';
  delete from public.requirements where id = rq;
  get diagnostics n = row_count; assert n = 1, 'ADMIN deletes requirement';
  select count(*) into n from public.tasks where requirement_id = rq; assert n = 0, 'deleting a requirement cascades to its tasks';

  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select id into rq from public.create_requirement(p_a2, 'Owner cascade');
  delete from public.requirements where id = rq;
  get diagnostics n = row_count; assert n = 1, 'OWNER deletes requirement';

  reset role;
  select count(*) into n from public.requirements where project_id = p_a2; assert n > 0, 'cascade setup (project has requirements)';
  delete from public.projects where id = p_a2;
  select count(*) into n from public.requirements where project_id = p_a2; assert n = 0, 'deleting a project cascades to requirements';
  select count(*) into n from public.tasks where id = tk_a2; assert n = 0, '...and through them to tasks';
  select count(*) into n from public.tasks where id = tk_a; assert n = 1, 'other projects untouched';
  delete from public.teams where id = team_a;
  select count(*) into n from public.requirements where project_id = p_a; assert n = 0, 'deleting a team cascades through projects to requirements';
  select count(*) into n from public.tasks where id = tk_a; assert n = 0, '...and tasks';
  delete from public.departments where id = dept1;
  select count(*) into n from public.requirements where id = rq_b; assert n = 0, 'deleting a department cascades down to requirements';
  select count(*) into n from public.requirements where id = rq_bb; assert n = 1, 'other organization untouched by cascade';
  delete from public.organizations where id = org2;
  select count(*) into n from public.tasks where id = tk_bb; assert n = 0, 'deleting an organization cascades all the way to tasks';

  raise notice 'ALL REQUIREMENT AND TASK CHECKS PASSED';
end;
$$;

rollback;
