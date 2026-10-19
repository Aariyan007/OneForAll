-- QA stage, defects, requirement completion rule, mentions, links, declining, unassignable notices, deadlines and
-- planning activity (migration 20261027000001). One transaction, rolled back. Fixture rows only; no global counts.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/sdlc_qa_rls.sql

begin;

do $$
declare
  o    uuid := '00000000-0000-0000-0000-0000000006a1';  -- OWNER
  a    uuid := '00000000-0000-0000-0000-0000000006a2';  -- ADMIN
  dev  uuid := '00000000-0000-0000-0000-0000000006a3';  -- employee, team Web (project team)
  peer uuid := '00000000-0000-0000-0000-0000000006a4';  -- employee, team Web
  qa   uuid := '00000000-0000-0000-0000-0000000006a5';  -- employee, team QA (collaborating team)
  away uuid := '00000000-0000-0000-0000-0000000006a6';  -- employee, team API (not on the project)
  o2   uuid := '00000000-0000-0000-0000-0000000006b1';  -- OWNER of another organization
  org1 uuid; org2 uuid; dept uuid; t_web uuid; t_qa uuid; t_api uuid; p1 uuid; rq uuid;
  k1 uuid; k2 uuid; k3 uuid; k4 uuid; k5 uuid; k6 uuid; d1 uuid; d2 uuid; l1 uuid; h uuid;
  r record; n int; caught boolean;
begin
  insert into auth.users (id, email) values (o,'o@qa.local'),(a,'a@qa.local'),(dev,'dev@qa.local'),(peer,'peer@qa.local'),
    (qa,'qa@qa.local'),(away,'away@qa.local'),(o2,'o2@qa.local');
  insert into public.organizations (name, slug, created_by) values ('QA One','qa-one',o) returning id into org1;
  insert into public.organizations (name, slug, created_by) values ('QA Two','qa-two',o2) returning id into org2;
  insert into public.organization_members (organization_id, user_id, role) values
    (org1,o,'OWNER'),(org1,a,'ADMIN'),(org1,dev,'MEMBER'),(org1,peer,'MEMBER'),(org1,qa,'MEMBER'),(org1,away,'MEMBER'),(org2,o2,'OWNER');
  insert into public.departments (organization_id, name, slug, created_by) values (org1,'Eng','eng',o) returning id into dept;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'Web','web',o) returning id into t_web;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'QA','qa',o) returning id into t_qa;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'API','api',o) returning id into t_api;
  insert into public.department_members (department_id, user_id) values (dept,dev),(dept,peer),(dept,qa),(dept,away);
  insert into public.team_members (team_id, user_id) values (t_web,dev),(t_web,peer),(t_qa,qa),(t_api,away);
  insert into public.projects (team_id, name, slug, project_type, created_by) values (t_web,'Shop','shop','BROWNFIELD',o) returning id into p1;
  insert into public.requirements (project_id, title, created_by, status) values (p1,'Checkout',o,'IN_PROGRESS') returning id into rq;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Payment form',o) returning id into k1;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Receipt email',o) returning id into k2;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Coupon field',o) returning id into k3;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Fraud check',o) returning id into k4;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Due soon',o) returning id into k5;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Overdue',o) returning id into k6;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.add_project_team(p1, t_qa);
  update public.tasks set qa_required = true, due_date = current_date + 10 where id = k1;
  select count(*) into n from public.task_events where task_id = k1 and event_type in ('QA_REQUIREMENT_CHANGED', 'DUE_DATE_CHANGED');
  assert n = 2, 'QA policy and due date changes are logged';
  perform public.assign_task(k1, dev, null, 'MANUAL', null);

  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  caught := false;
  begin update public.tasks set qa_required = false where id = k1; get diagnostics n = row_count; exception when insufficient_privilege then caught := true; end;
  assert caught or n = 0, 'an employee cannot switch QA off';
  perform public.transition_task(k1, 'IN_PROGRESS', null);
  perform public.transition_task(k1, 'IN_REVIEW', null);

  ------------------------------------------------------------------ review -> QA
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.transition_task(k1, 'COMPLETED', null); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a task that requires QA cannot be completed from review';
  perform public.transition_task(k1, 'IN_QA', null);
  caught := false; begin perform public.assign_task(k1, peer, dev); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a task in QA cannot be reassigned';
  reset role;
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.qa_requested' and user_id = peer;
  assert n = 1, 'the responsible team (not the assignee) is asked to test';
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.qa_requested' and user_id = dev;
  assert n = 0, 'the assignee is not asked to test their own work';
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.review_approved' and user_id = dev;
  assert n = 1, 'the assignee is told the review passed';
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.transition_task(k1, 'COMPLETED', null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the assignee cannot pass their own QA';
  caught := false; begin perform public.report_task_defect(k1, 'x', null, 'LOW'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the assignee cannot report defects on their own task';
  perform set_config('request.jwt.claims', json_build_object('sub', away, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.report_task_defect(k1, 'x', null, 'LOW'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'someone outside the project cannot report defects';

  ------------------------------------------------------------------ defects
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.transition_task(k1, 'IN_PROGRESS', null); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'failing QA needs a reason';
  caught := false; begin perform public.report_task_defect(k1, 'x', null, 'URGENT'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'unknown severity refused';
  d1 := public.report_task_defect(k1, 'Card number accepts letters', 'Steps: type abc', 'HIGH');
  select status into r from public.tasks where id = k1;
  assert r.status = 'IN_PROGRESS', 'a defect sends the task back to the assignee';
  reset role;
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.defect_reported' and user_id = dev;
  assert n = 1, 'the assignee is told about the defect';
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'IN_REVIEW', null);
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.transition_task(k1, 'IN_QA', null); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'open defects block QA';
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.resolve_task_defect(d1, 'fixed'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'only the assignee or an admin resolves';
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  perform public.resolve_task_defect(d1, 'Input mask added');
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = peer and type = 'task.defect_resolved';
  assert n = 1, 'the reporter is told the defect was resolved';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'IN_QA', null);

  ------------------------------------------------------------------ handoff to the QA team moves testing there
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  h := public.create_task_handoff(k1, t_qa, 'Ready for regression', null, null);
  perform set_config('request.jwt.claims', json_build_object('sub', qa, 'role', 'authenticated')::text, true);
  perform public.respond_task_handoff(h, true, 'Taking it', false);
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.transition_task(k1, 'COMPLETED', null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'after the handoff the old team no longer tests it';
  perform set_config('request.jwt.claims', json_build_object('sub', qa, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'COMPLETED', null);
  select status into r from public.tasks where id = k1;
  assert r.status = 'COMPLETED', 'QA team passes it';

  ------------------------------------------------------------------ requirement completion rule
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false; begin update public.requirements set status = 'COMPLETED' where id = rq; exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a requirement with open tasks cannot be completed';

  ------------------------------------------------------------------ defect on a completed task reopens it
  perform set_config('request.jwt.claims', json_build_object('sub', qa, 'role', 'authenticated')::text, true);
  d2 := public.report_task_defect(k1, 'Receipt total wrong', null, 'CRITICAL');
  select status into r from public.tasks where id = k1;
  assert r.status = 'IN_PROGRESS', 'a defect reopens a completed task';

  ------------------------------------------------------------------ mentions
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  select count(*) into n from public.task_mention_candidates(k1) where user_id in (peer, qa, a, o);
  assert n = 4, 'mention candidates: people who can see the project';
  select count(*) into n from public.task_mention_candidates(k1) where user_id in (dev, away, o2);
  assert n = 0, 'not oneself, not people outside the project or organization';
  caught := false; begin perform public.add_task_comment(k1, 'hey', array[away]); exception when insufficient_privilege then caught := true; end;
  assert caught, 'cannot mention someone who cannot see the task';
  perform public.add_task_comment(k1, 'Can you double-check the total?', array[peer, qa]);
  perform public.add_task_comment(k1, 'Plain comment without mentions');
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.add_task_comment(k1, 'Ping', array[dev]);
  reset role;
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.mentioned' and user_id in (peer, qa);
  assert n = 2, 'mentioned people are notified';
  select count(*) into n from public.notifications where task_id = k1 and type = 'task.mentioned' and user_id = dev;
  assert n = 1, 'the mentioned assignee gets a mention';
  select count(*) into n from public.notifications n2 join public.task_comments c on n2.dedupe_key = 'task.comment:' || c.id
    where n2.user_id = dev and c.body = 'Ping';
  assert n = 0, '...and no duplicate comment notification';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', away, 'role', 'authenticated')::text, true);
  caught := false; begin perform * from public.task_mention_candidates(k1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'mention candidates only for viewers of the task';

  ------------------------------------------------------------------ links
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  l1 := public.add_task_link(k1, 'https://github.com/acme/shop/pull/42', 'PR #42');
  caught := false; begin perform public.add_task_link(k1, 'http://insecure.example', null); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'only https links';
  caught := false; begin perform public.add_task_link(k1, 'javascript:alert(1)', null); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'no script links';
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  select count(*) into n from public.task_links where task_id = k1;
  assert n = 1, 'project members can read links';
  caught := false; begin perform public.add_task_link(k1, 'https://example.com', null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'only the assignee or an admin adds links';
  caught := false; begin perform public.remove_task_link(l1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'others cannot remove a link';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.task_links where task_id = k1;
  assert n = 0, 'another organization sees no links';
  select count(*) into n from public.task_defects where task_id = k1;
  assert n = 0, 'another organization sees no defects';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.remove_task_link(l1);
  select count(*) into n from public.task_events where task_id = k1 and event_type in ('LINK_ADDED', 'LINK_REMOVED');
  assert n = 2, 'links are logged';

  ------------------------------------------------------------------ declining an assignment
  perform public.assign_task(k3, dev, null, 'MANUAL', null);
  perform set_config('request.jwt.claims', json_build_object('sub', peer, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.decline_task_assignment(k3, 'not mine'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'only the assignee declines';
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.decline_task_assignment(k3, '  '); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'declining needs a reason';
  perform public.decline_task_assignment(k3, 'No Vue experience');
  select assignee_id into r from public.tasks where id = k3;
  assert r.assignee_id is null, 'declined: back in the queue';
  reset role;
  select count(*) into n from public.notifications where task_id = k3 and type = 'task.assignment_declined' and user_id = a;
  assert n = 1, 'the admin who assigned it is told once';
  select count(*) into n from public.notifications where task_id = k3 and type = 'task.assignment_declined' and user_id = o;
  assert n = 1, 'the owner is told';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.assign_task(k3, dev, null, 'MANUAL', null);
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  perform public.transition_task(k3, 'IN_PROGRESS', null);
  caught := false; begin perform public.decline_task_assignment(k3, 'too late'); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a started task cannot be declined';

  ------------------------------------------------------------------ nobody eligible
  caught := false; begin perform public.report_unassignable_task(k4, 'x'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'only managers report unassignable tasks';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.report_unassignable_task(k4, 'Nobody has the Fraud skill');
  perform public.report_unassignable_task(k4, 'Nobody has the Fraud skill');
  reset role;
  select count(*) into n from public.notifications where task_id = k4 and type = 'task.unassignable' and user_id = o;
  assert n = 1, 'the other managers are told once per day';
  set local role authenticated;

  ------------------------------------------------------------------ deadlines
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  update public.tasks set due_date = current_date + 1 where id = k5;
  update public.tasks set due_date = current_date - 1 where id = k6;
  perform public.assign_task(k5, dev, null, 'MANUAL', null);
  perform public.assign_task(k6, dev, null, 'MANUAL', null);
  perform set_config('request.jwt.claims', json_build_object('sub', dev, 'role', 'authenticated')::text, true);
  assert public.generate_deadline_notifications() >= 2, 'deadline notifications generated';
  assert public.generate_deadline_notifications() = 0, 'generated once per due date';
  select count(*) into n from public.notifications where user_id = dev and task_id = k5 and type = 'task.deadline';
  assert n = 1, 'due soon';
  select count(*) into n from public.notifications where user_id = dev and task_id = k6 and type = 'task.overdue';
  assert n = 1, 'overdue';

  ------------------------------------------------------------------ workload counts QA; requirement completes when done
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  select active_tasks into r from public.organization_workload(org1) where user_id = dev;
  assert r.active_tasks = 4, 'workload counts the open tasks (k1 reopened, k3, k5, k6)';
  perform public.transition_task(k2, 'CANCELLED', 'Out of scope');
  perform public.transition_task(k4, 'CANCELLED', 'Out of scope');
  perform public.transition_task(k5, 'CANCELLED', 'Out of scope');
  perform public.transition_task(k6, 'CANCELLED', 'Out of scope');
  perform public.transition_task(k3, 'CANCELLED', 'Out of scope');
  perform public.transition_task(k1, 'CANCELLED', 'Out of scope');
  update public.requirements set status = 'COMPLETED' where id = rq;
  select status into r from public.requirements where id = rq;
  assert r.status = 'COMPLETED', 'the requirement completes once every task is finished';

  reset role;
  raise notice 'ALL SDLC QA CHECKS PASSED';
end;
$$;

rollback;
