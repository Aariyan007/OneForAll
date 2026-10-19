-- Task assignment and workflow: assignment (eligibility, compare-and-set), candidates and workload, status actors and
-- reasons, dependencies and cycles, comments, notifications, collaborating teams and handoffs, settings, leaving.
-- One transaction, rolled back at the end. Fixture rows only; no global counts.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/task_workflow_rls.sql

begin;

do $$
declare
  o   uuid := '00000000-0000-0000-0000-0000000003a1';  -- OWNER org 1
  a   uuid := '00000000-0000-0000-0000-0000000003a2';  -- ADMIN org 1
  e1  uuid := '00000000-0000-0000-0000-0000000003a3';  -- employee, team Web (project team), skill React
  e2  uuid := '00000000-0000-0000-0000-0000000003a4';  -- employee, team Web, UNAVAILABLE
  e3  uuid := '00000000-0000-0000-0000-0000000003a5';  -- employee, team API (not on the project)
  q1  uuid := '00000000-0000-0000-0000-0000000003a6';  -- employee, team QA
  o2  uuid := '00000000-0000-0000-0000-0000000003b1';  -- OWNER org 2
  u2  uuid := '00000000-0000-0000-0000-0000000003b2';  -- MEMBER org 2
  org1 uuid; org2 uuid; dept uuid; t_web uuid; t_api uuid; t_qa uuid; p1 uuid; p2 uuid; rq uuid; rq2 uuid;
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; kx uuid; sk_react uuid; h1 uuid; h2 uuid; c1 uuid;
  r record; n int; caught boolean;
begin
  insert into auth.users (id, email) values (o,'o@tw.local'),(a,'a@tw.local'),(e1,'e1@tw.local'),(e2,'e2@tw.local'),
    (e3,'e3@tw.local'),(q1,'q1@tw.local'),(o2,'o2@tw.local'),(u2,'u2@tw.local');
  insert into public.organizations (name, slug, created_by) values ('TW One','tw-one',o) returning id into org1;
  insert into public.organizations (name, slug, created_by) values ('TW Two','tw-two',o2) returning id into org2;
  insert into public.organization_members (organization_id, user_id, role) values
    (org1,o,'OWNER'),(org1,a,'ADMIN'),(org1,e1,'MEMBER'),(org1,e2,'MEMBER'),(org1,e3,'MEMBER'),(org1,q1,'MEMBER'),(org2,o2,'OWNER'),(org2,u2,'MEMBER');
  insert into public.departments (organization_id, name, slug, created_by) values (org1,'Eng','eng',o) returning id into dept;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'Web','web',o) returning id into t_web;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'API','api',o) returning id into t_api;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'QA','qa',o) returning id into t_qa;
  insert into public.department_members (department_id, user_id) values (dept,e1),(dept,e2),(dept,e3),(dept,q1);
  insert into public.team_members (team_id, user_id) values (t_web,e1),(t_web,e2),(t_api,e3),(t_qa,q1);
  insert into public.projects (team_id, name, slug, project_type, created_by) values (t_web,'Shop','shop','BROWNFIELD',o) returning id into p1;
  insert into public.projects (team_id, name, slug, project_type, created_by) values (t_web,'Other','other','GREENFIELD',o) returning id into p2;
  insert into public.requirements (project_id, title, created_by) values (p1,'Checkout',o) returning id into rq;
  insert into public.requirements (project_id, title, created_by) values (p2,'Elsewhere',o) returning id into rq2;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'API contract',o) returning id into k1;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Integrate UI',o) returning id into k2;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Cart page',o) returning id into k3;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Spare',o) returning id into k4;
  insert into public.tasks (requirement_id, title, created_by) values (rq2,'Other project task',o) returning id into kx;
  insert into public.skills (organization_id, name) values (org1,'React') returning id into sk_react;
  insert into public.workforce_profile_skills (profile_id, skill_id)
    select w.id, sk_react from public.workforce_profiles w where w.organization_id = org1 and w.user_id = e1;
  update public.workforce_profiles set availability = 'UNAVAILABLE' where organization_id = org1 and user_id = e2;

  select count(*) into n from public.task_events where task_id = k1 and event_type = 'CREATED';
  assert n = 1, 'creating a task logs CREATED';
  assert not has_column_privilege('authenticated', 'public.tasks', 'status', 'update'), 'no client update of status';
  assert not has_column_privilege('authenticated', 'public.tasks', 'assignee_id', 'update'), 'no client update of assignee';
  assert has_column_privilege('authenticated', 'public.tasks', 'acceptance_criteria', 'update'), 'planning fields remain editable (RLS: managers)';
  assert not has_table_privilege('authenticated', 'public.notifications', 'insert'), 'no client insert of notifications';
  assert not has_table_privilege('authenticated', 'public.task_comments', 'insert'), 'comments only through add_task_comment()';

  set local role authenticated;

  ------------------------------------------------------------------ assignment
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.set_task_required_skills(k1, array[sk_react]);
  select * into r from public.task_assignment_candidates(k1) where user_id = e1;
  assert r.matched_skills = 1 and r.required_skills = 1 and r.in_project_team and r.active_tasks = 0, 'candidate facts for e1';
  select count(*) into n from public.task_assignment_candidates(k1) where user_id in (e3, q1, u2);
  assert n = 0, 'people without project access are not candidates';
  select availability into r from public.task_assignment_candidates(k1) where user_id = e2;
  assert r.availability = 'UNAVAILABLE', 'availability is reported';

  perform public.assign_task(k1, e1, null, 'RECOMMENDED', 'Best skill match');
  select assignee_id, assigned_by, status into r from public.tasks where id = k1;
  assert r.assignee_id = e1 and r.assigned_by = a and r.status = 'TODO', 'assigned, still TODO (assigned is not in progress)';
  caught := false;
  begin perform public.assign_task(k1, e2, null); exception when sqlstate '40001' then caught := true; end;
  assert caught, 'stale expected assignee: concurrent assignment refused';
  caught := false;
  begin perform public.assign_task(k3, e2, null); exception when check_violation then caught := true; end;
  assert caught, 'an unavailable person cannot be assigned';
  caught := false;
  begin perform public.assign_task(k3, e3, null); exception when check_violation then caught := true; end;
  assert caught, 'someone without project access cannot be assigned';
  caught := false;
  begin perform public.assign_task(k3, u2, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant''s user cannot be assigned';
  caught := false;
  begin perform public.assign_task(k3, e1, null, 'WHATEVER'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'unknown mode refused';
  select count(*) into n from public.task_events where task_id = k1 and event_type = 'ASSIGNED' and details ->> 'mode' = 'RECOMMENDED';
  assert n = 1, 'assignment logged with mode and reason';
  select * into r from public.organization_workload(org1) where user_id = e1;
  assert r.active_tasks = 1, 'workload counts the assigned task';

  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.assign_task(k3, e1, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot assign';
  caught := false;
  begin perform * from public.task_assignment_candidates(k1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot list candidates';
  caught := false;
  begin perform * from public.organization_workload(org1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot read workload';
  caught := false;
  begin update public.tasks set assignee_id = e1 where id = k3; exception when insufficient_privilege then caught := true; end;
  assert caught, 'direct assignment refused';
  select count(*) into n from public.notifications where user_id = e1 and type = 'task.assigned' and task_id = k1;
  assert n = 1, 'the assignee is notified';
  select link into r from public.notifications where user_id = e1 and task_id = k1 limit 1;
  assert r.link like '/organizations/' || org1 || '/departments/%/tasks/' || k1, 'notification links to the task';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.assign_task(k3, null, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot assign';

  ------------------------------------------------------------------ status workflow
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.transition_task(k1, 'IN_PROGRESS'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a teammate who is not the assignee cannot start the task';
  perform set_config('request.jwt.claims', json_build_object('sub', e3, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.transition_task(k1, 'IN_PROGRESS'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'someone outside the project cannot touch the task';

  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'IN_PROGRESS');
  caught := false;
  begin perform public.transition_task(k1, 'BLOCKED', '  '); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'blocking needs a reason';
  perform public.transition_task(k1, 'BLOCKED', 'Waiting for API keys');
  perform public.transition_task(k1, 'IN_PROGRESS');
  perform public.transition_task(k1, 'IN_REVIEW');
  caught := false;
  begin perform public.transition_task(k1, 'COMPLETED'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the assignee cannot approve their own work';
  caught := false;
  begin perform public.transition_task(k1, 'CANCELLED', 'nah'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the assignee cannot cancel';

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.blocked' and user_id = a and body = 'Waiting for API keys';
  assert n = 1, 'the person who assigned the task is told it is blocked, with the reason';
  select count(*) into n from public.notifications where task_id = k1 and user_id <> a;
  assert n = 0, 'nobody reads someone else''s notifications';
  caught := false;
  begin perform public.transition_task(k1, 'IN_PROGRESS'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'requesting changes needs a description';
  perform public.transition_task(k1, 'IN_PROGRESS', 'Add error states');
  caught := false;
  begin perform public.assign_task(k1, e2, e1); exception when check_violation then caught := true; end;
  assert caught, 'reassigning to an unavailable person still refused';

  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = e1 and task_id = k1 and type = 'task.changes_requested';
  assert n = 1, 'the assignee is told about requested changes';
  perform public.transition_task(k1, 'IN_REVIEW');

  ------------------------------------------------------------------ dependencies
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.add_task_dependency(k2, k1);
  caught := false;
  begin perform public.add_task_dependency(k1, k2); exception when check_violation then caught := true; end;
  assert caught, 'a cycle is refused';
  caught := false;
  begin perform public.add_task_dependency(k1, k1); exception when check_violation then caught := true; end;
  assert caught, 'self-dependency refused';
  caught := false;
  begin perform public.add_task_dependency(k2, kx); exception when check_violation then caught := true; end;
  assert caught, 'cross-project dependency refused';
  perform public.assign_task(k2, e1, null);
  caught := false;
  begin perform public.transition_task(k3, 'IN_PROGRESS'); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'an unassigned task cannot be started';

  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.add_task_dependency(k3, k1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot add dependencies';
  caught := false;
  begin perform public.transition_task(k2, 'IN_PROGRESS'); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a task waiting on an unfinished dependency cannot start';

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'COMPLETED');
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = e1 and task_id = k2 and type = 'task.dependencies_done';
  assert n = 1, 'the waiting task''s assignee is told it can start';
  perform public.transition_task(k2, 'IN_PROGRESS');

  ------------------------------------------------------------------ comments and activity
  c1 := public.add_task_comment(k2, ' Started on the form ');
  select body into r from public.task_comments where id = c1;
  assert r.body = 'Started on the form', 'comment stored (trimmed)';
  caught := false;
  begin perform public.add_task_comment(k2, '   '); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'empty comment refused';
  select count(*) into n from public.task_events where task_id = k1 and event_type = 'STATUS_CHANGED';
  assert n = 7, 'every status change is in the activity log (start, block, resume, review, changes, review, approve)';
  select count(*) into n from public.task_events where task_id = k1 and event_type = 'STATUS_CHANGED' and to_status = 'BLOCKED' and details ->> 'reason' = 'Waiting for API keys';
  assert n = 1, 'the blocker reason is recorded';
  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.add_task_comment(k2, 'hi'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'someone without project access cannot comment';
  select count(*) into n from public.task_events where task_id = k1;
  assert n = 0, 'nor read the activity';
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.add_task_comment(k2, 'hi'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot comment';

  ------------------------------------------------------------------ notifications
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where read_at is null;
  assert n >= 3, 'the employee has unread notifications';
  perform public.mark_notifications_read(null);
  select count(*) into n from public.notifications where read_at is null;
  assert n = 0, 'mark all as read';
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = e1;
  assert n = 0, 'nobody reads someone else''s notifications';

  ------------------------------------------------------------------ collaborating teams and handoffs
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.add_project_team(p1, t_qa); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot add collaborating teams';
  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.projects where id = p1;
  assert n = 0, 'before collaboration QA cannot see the project';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.add_project_team(p1, t_qa);
  perform public.assign_task(k3, e1, null);
  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.projects where id = p1;
  assert n = 1, 'a collaborating team sees the project';

  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_task_handoff(k3, t_qa, 'done', null, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'only the assignee or a manager hands off';
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_task_handoff(k3, t_api, 'done', null, null); exception when check_violation then caught := true; end;
  assert caught, 'a team that does not work on the project cannot receive a handoff';
  h1 := public.create_task_handoff(k3, t_qa, 'Cart UI finished', 'Test on mobile', 'See PR 12');
  caught := false;
  begin perform public.create_task_handoff(k3, t_qa, 'again', null, null); exception when unique_violation then caught := true; end;
  assert caught, 'one pending handoff per task';

  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = q1 and type = 'task.handoff' and task_id = k3;
  assert n = 1, 'the receiving team is notified';
  select summary, remaining_work into r from public.task_handoffs where id = h1;
  assert r.summary = 'Cart UI finished' and r.remaining_work = 'Test on mobile', 'the receiving team reads the context';
  perform set_config('request.jwt.claims', json_build_object('sub', e3, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.respond_task_handoff(h1, true, null, true); exception when insufficient_privilege then caught := true; end;
  assert caught, 'someone outside the receiving team cannot accept';
  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  perform public.respond_task_handoff(h1, true, 'On it', true);
  select assignee_id, team_id into r from public.tasks where id = k3;
  assert r.assignee_id = q1 and r.team_id = t_qa, 'accepting moves responsibility and (with take) the assignment';
  caught := false;
  begin perform public.respond_task_handoff(h1, false, null); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a handoff is answered once';
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = e1 and task_id = k3 and type in ('task.handoff_accepted', 'task.unassigned');
  assert n = 2, 'the sender learns the handoff was accepted and that the task moved';
  select count(*) into n from public.task_events where task_id = k3 and event_type in ('HANDOFF_CREATED', 'HANDOFF_ACCEPTED');
  assert n = 2, 'the handoff is in the activity log';

  perform set_config('request.jwt.claims', json_build_object('sub', q1, 'role', 'authenticated')::text, true);
  h2 := public.create_task_handoff(k3, t_web, 'Found two defects', 'Fix totals', null);
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  perform public.respond_task_handoff(h2, false, 'Not ours');
  select status into r from public.task_handoffs where id = h2;
  assert r.status = 'DECLINED', 'a receiving team member can decline';

  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.remove_project_team(p1, t_qa); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a team that still owns open tasks cannot be removed from the project';

  ------------------------------------------------------------------ assignment policy
  caught := false;
  begin perform public.set_assignment_mode(org1, 'AUTO'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an admin cannot change the assignment policy';
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  perform public.set_assignment_mode(org1, 'RECOMMEND');
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  select assignment_mode into r from public.organization_settings where organization_id = org1;
  assert r.assignment_mode = 'RECOMMEND', 'members read the policy';
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.organization_settings where organization_id = org1;
  assert n = 0, 'other tenants do not';

  ------------------------------------------------------------------ leaving unassigns
  reset role;
  delete from public.organization_members where organization_id = org1 and user_id = e1;
  select assignee_id, status into r from public.tasks where id = k2;
  assert r.assignee_id is null and r.status = 'TODO', 'leaving unassigns and returns in-progress work to TODO';

  raise notice 'ALL TASK WORKFLOW CHECKS PASSED';
end;
$$;

rollback;
