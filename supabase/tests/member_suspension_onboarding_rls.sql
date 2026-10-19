-- Member suspension (RLS-wide effect), invitation notifications and expiry, departments/teams CSV import
-- (migration 20261026000001). One transaction, rolled back. Fixture rows only; no global counts.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/member_suspension_onboarding_rls.sql

begin;

do $$
declare
  o   uuid := '00000000-0000-0000-0000-0000000005a1';  -- OWNER org 1
  a   uuid := '00000000-0000-0000-0000-0000000005a2';  -- ADMIN org 1
  e1  uuid := '00000000-0000-0000-0000-0000000005a3';  -- employee, team Web, assigned a task
  e2  uuid := '00000000-0000-0000-0000-0000000005a4';  -- employee
  x   uuid := '00000000-0000-0000-0000-0000000005a5';  -- invitee (no membership yet)
  o2  uuid := '00000000-0000-0000-0000-0000000005b1';  -- OWNER org 2
  org1 uuid; org2 uuid; dept uuid; t_web uuid; p1 uuid; rq uuid; k1 uuid; m_e1 uuid; m_a uuid; m_o uuid; inv uuid;
  r record; n int; caught boolean; tok text;
begin
  insert into auth.users (id, email) values (o,'o@ms.local'),(a,'a@ms.local'),(e1,'e1@ms.local'),(e2,'e2@ms.local'),
    (x,'x@ms.local'),(o2,'o2@ms.local');
  insert into public.organizations (name, slug, created_by) values ('MS One','ms-one',o) returning id into org1;
  insert into public.organizations (name, slug, created_by) values ('MS Two','ms-two',o2) returning id into org2;
  insert into public.organization_members (organization_id, user_id, role) values
    (org1,o,'OWNER'),(org1,a,'ADMIN'),(org1,e1,'MEMBER'),(org1,e2,'MEMBER'),(org2,o2,'OWNER');
  select id into m_e1 from public.organization_members where organization_id = org1 and user_id = e1;
  select id into m_a from public.organization_members where organization_id = org1 and user_id = a;
  select id into m_o from public.organization_members where organization_id = org1 and user_id = o;
  insert into public.departments (organization_id, name, slug, created_by) values (org1,'Eng','eng',o) returning id into dept;
  insert into public.teams (department_id, name, slug, created_by) values (dept,'Web','web',o) returning id into t_web;
  insert into public.department_members (department_id, user_id) values (dept,e1);
  insert into public.team_members (team_id, user_id) values (t_web,e1);
  insert into public.projects (team_id, name, slug, project_type, created_by) values (t_web,'Shop','shop','BROWNFIELD',o) returning id into p1;
  insert into public.requirements (project_id, title, created_by) values (p1,'Checkout',o) returning id into rq;
  insert into public.tasks (requirement_id, title, created_by) values (rq,'Cart',o) returning id into k1;

  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.assign_task(k1, e1, null, 'MANUAL', null);
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  perform public.transition_task(k1, 'IN_PROGRESS', null);
  assert public.is_org_member(org1), 'e1 is an active member';
  select count(*) into n from public.projects where id = p1;
  assert n = 1, 'e1 sees the team project';

  ------------------------------------------------------------------ who may suspend
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.suspend_organization_member(m_e1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot suspend';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.suspend_organization_member(m_o); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nobody suspends an owner';
  caught := false; begin perform public.suspend_organization_member(m_a); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nobody suspends themselves';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.suspend_organization_member(m_e1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another organization''s owner cannot suspend';

  ------------------------------------------------------------------ suspension takes effect everywhere
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.suspend_organization_member(m_e1);
  select status, assignee_id into r from public.tasks where id = k1;
  assert r.assignee_id is null and r.status = 'TODO', 'suspension unassigns open tasks (in progress returns to TODO)';
  select count(*) into n from public.task_events where task_id = k1 and event_type = 'UNASSIGNED' and details ->> 'reason' = 'member suspended';
  assert n = 1, 'the unassignment is logged';
  caught := false; begin perform public.assign_task(k1, e1, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a suspended member cannot be assigned';
  select count(*) into n from public.organization_audit_events where organization_id = org1 and action = 'member.suspended' and target_user_id = e1;
  assert n = 1, 'suspension is audited';

  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  assert not public.is_org_member(org1), 'suspended: not a member for RLS';
  select count(*) into n from public.organizations where id = org1;
  assert n = 0, 'suspended: organization hidden';
  select count(*) into n from public.projects where id = p1;
  assert n = 0, 'suspended: team project hidden';
  select count(*) into n from public.tasks where id = k1;
  assert n = 0, 'suspended: tasks hidden';
  select count(*) into n from public.departments where id = dept;
  assert n = 0, 'suspended: departments hidden';
  select count(*) into n from public.list_my_suspended_memberships() where organization_id = org1;
  assert n = 1, 'suspended: the dashboard can explain the missing access';
  caught := false; begin perform public.transition_task(k1, 'IN_PROGRESS', null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'suspended: cannot change tasks';
  caught := false; begin perform public.remove_organization_member(m_e1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'suspended: cannot act in the organization (not even leave)';

  ------------------------------------------------------------------ reactivation
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.reactivate_organization_member(m_e1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot reactivate';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.reactivate_organization_member(m_e1);
  perform set_config('request.jwt.claims', json_build_object('sub', e1, 'role', 'authenticated')::text, true);
  assert public.is_org_member(org1), 'reactivated: access restored';
  select count(*) into n from public.projects where id = p1;
  assert n = 1, 'reactivated: project visible again (team membership kept)';
  select count(*) into n from public.notifications where user_id = e1 and type = 'member.reactivated';
  assert n = 1, 'the person is told their access was restored';
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  perform public.suspend_organization_member(m_a);
  select status into r from public.organization_members where id = m_a;
  assert r.status = 'SUSPENDED', 'an owner may suspend an admin';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  assert not public.has_org_role(org1, array['OWNER', 'ADMIN']), 'a suspended admin holds no admin role';
  caught := false; begin perform public.import_organization_structure(org1, 'DEPARTMENTS', '[]'::jsonb, false); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a suspended admin cannot import';
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  perform public.reactivate_organization_member(m_a);

  ------------------------------------------------------------------ invitations: accepted, revoked, expired
  select * into r from public.create_organization_invitation(org1, 'x@ms.local', 'MEMBER');
  tok := r.token;
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  perform public.accept_organization_invitation(tok);
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = o and type = 'member.invitation_accepted';
  assert n = 1, 'the inviter is told the invitation was accepted';

  select * into r from public.create_organization_invitation(org1, 'later@ms.local', 'MEMBER');
  inv := r.invitation_id;
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  perform public.revoke_organization_invitation(inv);
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = o and type = 'member.invitation_revoked';
  assert n = 1, 'the inviter is told another admin revoked it';

  reset role;
  insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, expires_at, created_at)
  values (org1, 'stale@ms.local', 'MEMBER', extensions.digest('stale-token-for-test', 'sha256'), o, now() - interval '1 day', now() - interval '8 days')
  returning id into inv;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.close_expired_invitations(org1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot close invitations';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  assert public.close_expired_invitations(org1) = 1, 'one expired invitation closed';
  assert public.close_expired_invitations(org1) = 0, 'closing is idempotent';
  select status into r from public.organization_invitations where id = inv;
  assert r.status = 'EXPIRED', 'status EXPIRED';
  perform set_config('request.jwt.claims', json_build_object('sub', o, 'role', 'authenticated')::text, true);
  select count(*) into n from public.notifications where user_id = o and type = 'member.invitation_expired';
  assert n = 1, 'the inviter is told once';

  ------------------------------------------------------------------ departments / teams CSV
  perform set_config('request.jwt.claims', json_build_object('sub', e2, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.import_organization_structure(org1, 'DEPARTMENTS', '[]'::jsonb, false); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot import the structure';
  perform set_config('request.jwt.claims', json_build_object('sub', a, 'role', 'authenticated')::text, true);
  caught := false; begin perform public.import_organization_structure(org2, 'DEPARTMENTS', '[]'::jsonb, false); exception when insufficient_privilege then caught := true; end;
  assert caught, 'no import into another organization';

  select count(*) filter (where outcome = 'CREATE'), count(*) filter (where outcome = 'UNCHANGED'), count(*) filter (where outcome = 'ERROR')
  into r from public.import_organization_structure(org1, 'DEPARTMENTS',
    '[{"row":2,"name":"Quality"},{"row":3,"name":"ENG"},{"row":4,"name":"quality"},{"row":5,"name":""}]'::jsonb, false);
  assert r.count = 1, 'preview: one new department';
  select count(*) into n from public.departments where organization_id = org1 and name = 'Quality';
  assert n = 0, 'the preview writes nothing';
  select count(*) into n from public.import_organization_structure(org1, 'DEPARTMENTS',
    '[{"row":2,"name":"Quality"},{"row":3,"name":"ENG"},{"row":4,"name":"quality"},{"row":5,"name":""}]'::jsonb, false) where outcome = 'ERROR';
  assert n = 2, 'preview: duplicate in the file and empty name are errors';
  perform public.import_organization_structure(org1, 'DEPARTMENTS', '[{"row":2,"name":"Quality","description":"Testing"}]'::jsonb, true);
  select count(*) into n from public.departments where organization_id = org1 and name = 'Quality' and created_by = a;
  assert n = 1, 'apply creates the department as the caller';
  assert (select count(*) from public.import_organization_structure(org1, 'DEPARTMENTS', '[{"row":2,"name":"Quality","description":"Testing"}]'::jsonb, true) where outcome = 'UNCHANGED') = 1,
    'a repeated import changes nothing';

  select count(*) into n from public.import_organization_structure(org1, 'TEAMS',
    '[{"row":2,"department":"quality","name":"QA Squad"},{"row":3,"department":"Nope","name":"X"},{"row":4,"department":"Eng","name":"web","description":"Storefront"}]'::jsonb, true)
    where outcome in ('CREATE', 'UPDATE');
  assert n = 2, 'teams: one created, one description updated';
  select count(*) into n from public.teams t join public.departments d on d.id = t.department_id where d.organization_id = org1 and t.name = 'QA Squad';
  assert n = 1, 'team created in the named department';
  select count(*) into n from public.teams where id = t_web and description = 'Storefront';
  assert n = 1, 'existing team description updated';
  select count(*) into n from public.teams where name = 'X';
  assert n = 0, 'unknown department: skipped';
  select count(*) into n from public.organization_audit_events where organization_id = org1 and action = 'structure.imported';
  assert n = 2, 'each applying import is audited';

  reset role;
  raise notice 'ALL SUSPENSION AND ONBOARDING CHECKS PASSED';
end;
$$;

rollback;
