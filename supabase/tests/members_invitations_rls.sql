-- Membership management: co-member profiles, invitations, role changes, removal, audit trail.
-- One transaction, rolled back at the end. Fixture rows only; no global counts.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/members_invitations_rls.sql

begin;

do $$
declare
  o1 uuid := '00000000-0000-0000-0000-0000000001a1';  -- OWNER  org 1
  a1 uuid := '00000000-0000-0000-0000-0000000001a2';  -- ADMIN  org 1
  a2 uuid := '00000000-0000-0000-0000-0000000001a3';  -- ADMIN  org 1 (second admin)
  m1 uuid := '00000000-0000-0000-0000-0000000001a4';  -- MEMBER org 1, in dept 1 and team 1
  m2 uuid := '00000000-0000-0000-0000-0000000001a5';  -- MEMBER org 1
  o2 uuid := '00000000-0000-0000-0000-0000000001b1';  -- OWNER  org 2
  u2 uuid := '00000000-0000-0000-0000-0000000001b2';  -- MEMBER org 2
  x  uuid := '00000000-0000-0000-0000-0000000001c1';  -- no organization
  i1 uuid := '00000000-0000-0000-0000-0000000001c2';  -- invitee (no organization yet)
  org1 uuid; org2 uuid; dept1 uuid; team1 uuid;
  mem_m1 uuid; mem_m2 uuid; mem_a2 uuid; mem_o1 uuid; mem_a1 uuid; mem_u2 uuid;
  tok_admin text; tok_member text; tok_exp text; inv_admin uuid; inv_member uuid; inv_exp uuid;
  r record; n int; caught boolean; v_id uuid;
begin
  insert into auth.users (id, email) values
    (o1, 'o1@mi.local'), (a1, 'a1@mi.local'), (a2, 'a2@mi.local'), (m1, 'm1@mi.local'), (m2, 'm2@mi.local'),
    (o2, 'o2@mi.local'), (u2, 'u2@mi.local'), (x, 'x@mi.local'), (i1, 'Invitee@MI.local');
  insert into public.organizations (name, slug, created_by) values ('MI One', 'mi-one', o1) returning id into org1;
  insert into public.organizations (name, slug, created_by) values ('MI Two', 'mi-two', o2) returning id into org2;
  insert into public.organization_members (organization_id, user_id, role) values (org1, o1, 'OWNER') returning id into mem_o1;
  insert into public.organization_members (organization_id, user_id, role) values (org1, a1, 'ADMIN') returning id into mem_a1;
  insert into public.organization_members (organization_id, user_id, role) values (org1, a2, 'ADMIN') returning id into mem_a2;
  insert into public.organization_members (organization_id, user_id, role) values (org1, m1, 'MEMBER') returning id into mem_m1;
  insert into public.organization_members (organization_id, user_id, role) values (org1, m2, 'MEMBER') returning id into mem_m2;
  insert into public.organization_members (organization_id, user_id, role) values (org2, o2, 'OWNER');
  insert into public.organization_members (organization_id, user_id, role) values (org2, u2, 'MEMBER') returning id into mem_u2;
  insert into public.departments (organization_id, name, slug, created_by) values (org1, 'Eng', 'eng', o1) returning id into dept1;
  insert into public.teams (department_id, name, slug, created_by) values (dept1, 'Web', 'web', o1) returning id into team1;
  insert into public.department_members (department_id, user_id) values (dept1, m1);
  insert into public.team_members (team_id, user_id) values (team1, m1);

  ------------------------------------------------------------------ catalog
  select count(*) into n from pg_proc p join pg_namespace s on s.oid = p.pronamespace
  where s.nspname = 'public' and p.proname in ('create_organization_invitation', 'revoke_organization_invitation',
    'get_invitation_preview', 'accept_organization_invitation', 'list_my_invitations', 'change_member_role',
    'remove_organization_member', 'shares_organization')
    and p.prosecdef and p.proconfig @> array['search_path=""'];
  assert n = 8, 'all membership functions are SECURITY DEFINER with an empty search_path';
  assert not has_function_privilege('anon', 'public.create_organization_invitation(uuid, text, text)', 'execute'), 'anon cannot invite';
  assert not has_function_privilege('anon', 'public.accept_organization_invitation(text)', 'execute'), 'anon cannot accept';
  assert not has_function_privilege('authenticated', 'private.record_audit(uuid, text, uuid, text, jsonb)', 'execute'), 'clients cannot write audit events';
  assert not has_table_privilege('authenticated', 'public.organization_members', 'insert'), 'no client insert on memberships';
  assert not has_table_privilege('authenticated', 'public.organization_members', 'update'), 'no client update on memberships';
  assert not has_table_privilege('authenticated', 'public.organization_members', 'delete'), 'no client delete on memberships';
  assert not has_column_privilege('authenticated', 'public.organization_invitations', 'token_hash', 'select'), 'token hash is not readable';
  assert not has_table_privilege('authenticated', 'public.organization_invitations', 'insert'), 'no client insert on invitations';

  set local role authenticated;

  ------------------------------------------------------------------ co-member profiles
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id in (o1, a1, a2, m2);
  assert n = 4, 'a member sees the profiles of co-members';
  select count(*) into n from public.profiles where id in (o2, u2, x, i1);
  assert n = 0, 'a member sees no profiles outside their organizations';
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id <> x and id in (o1, a1, m1, o2, u2, i1);
  assert n = 0, 'a user without organization sees only their own profile';

  ------------------------------------------------------------------ invitations: who may invite what
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  select * into r from public.create_organization_invitation(org1, '  INVITEE@mi.local ', 'ADMIN');
  inv_admin := r.invitation_id; tok_admin := r.token;
  assert tok_admin ~ '^[A-Za-z0-9_-]{43}$', 'token is 32 random bytes, base64url';
  assert r.expires_at > now() + interval '6 days', 'expires in 7 days';
  select email into r from public.organization_invitations where id = inv_admin;
  assert r.email = 'invitee@mi.local', 'email normalized';

  caught := false;
  begin perform public.create_organization_invitation(org1, 'invitee@mi.local', 'MEMBER'); exception when unique_violation then caught := true; end;
  assert caught, 'second pending invitation for the same address refused';
  caught := false;
  begin perform public.create_organization_invitation(org1, 'm1@mi.local', 'MEMBER'); exception when unique_violation then caught := true; end;
  assert caught, 'existing member cannot be invited';
  caught := false;
  begin perform public.create_organization_invitation(org1, 'not-an-email', 'MEMBER'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'invalid email refused';
  caught := false;
  begin perform public.create_organization_invitation(org1, 'new@mi.local', 'OWNER'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'nobody can invite an OWNER';

  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_organization_invitation(org1, 'boss@mi.local', 'ADMIN'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an admin cannot invite an admin';
  select * into r from public.create_organization_invitation(org1, 'worker@mi.local', 'MEMBER');
  inv_member := r.invitation_id; tok_member := r.token;
  assert inv_member is not null, 'an admin can invite an employee';

  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_organization_invitation(org1, 'friend@mi.local', 'MEMBER'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot invite';
  select count(*) into n from public.organization_invitations where organization_id = org1;
  assert n = 0, 'an employee cannot list invitations';

  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_organization_invitation(org1, 'spy@mi.local', 'MEMBER'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an owner of another organization cannot invite into org 1';
  select count(*) into n from public.organization_invitations where organization_id = org1;
  assert n = 0, 'other tenants cannot see org 1 invitations';

  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.organization_invitations where organization_id = org1;
  assert n = 2, 'admins see their organization''s invitations';
  caught := false;
  begin perform token_hash from public.organization_invitations limit 1; exception when insufficient_privilege then caught := true; end;
  assert caught, 'the token hash cannot be selected';

  reset role;
  select count(*) into n from public.organization_invitations
  where id = inv_admin and token_hash = extensions.digest(convert_to(tok_admin, 'UTF8'), 'sha256');
  assert n = 1, 'only the SHA-256 of the token is stored';
  select count(*) into n from public.organization_audit_events where organization_id = org1 and action = 'member.invited';
  assert n = 2, 'invitations are audited';
  set local role authenticated;

  ------------------------------------------------------------------ preview and acceptance
  perform set_config('request.jwt.claims', json_build_object('sub', x, 'role', 'authenticated')::text, true);
  select * into r from public.get_invitation_preview(tok_admin);
  assert r.organization_name = 'MI One' and r.role = 'ADMIN' and r.status = 'PENDING' and r.email_matches = false
         and r.email_hint = 'i***@mi.local', 'preview for a different account: masked email, no match';
  select count(*) into n from public.get_invitation_preview('this-token-does-not-exist-0123456789');
  assert n = 0, 'unknown token: no data';
  caught := false;
  begin perform public.accept_organization_invitation(tok_admin); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a different account cannot accept the invitation';
  caught := false;
  begin perform public.accept_organization_invitation('this-token-does-not-exist-0123456789'); exception when sqlstate 'P0002' then caught := true; end;
  assert caught, 'unknown token refused';

  perform set_config('request.jwt.claims', json_build_object('sub', i1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.list_my_invitations();
  assert n = 1, 'the invitee sees their pending invitation (address compared case-insensitively)';
  select count(*) into n from public.organizations where id = org1;
  assert n = 0, 'before accepting, the organization is not visible';
  v_id := public.accept_organization_invitation(tok_admin);
  assert v_id = org1, 'accept returns the organization';
  select role into r from public.organization_members where organization_id = org1 and user_id = i1;
  assert r.role = 'ADMIN', 'membership created with the invited role';
  select count(*) into n from public.organizations where id = org1;
  assert n = 1, 'after accepting, the organization is visible';
  caught := false;
  begin perform public.accept_organization_invitation(tok_admin); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a token cannot be used twice';
  select count(*) into n from public.list_my_invitations();
  assert n = 0, 'accepted invitation no longer listed';

  ------------------------------------------------------------------ expiry and revocation
  reset role;
  tok_exp := 'expired-token-for-tests-0123456789abcdefghij';
  insert into public.organization_invitations (organization_id, email, role, token_hash, invited_by, created_at, expires_at)
  values (org1, 'late@mi.local', 'MEMBER', extensions.digest(convert_to(tok_exp, 'UTF8'), 'sha256'), o1, now() - interval '8 days', now() - interval '1 day')
  returning id into inv_exp;
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000001c3', 'late@mi.local');
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000001c3', 'role', 'authenticated')::text, true);
  select * into r from public.get_invitation_preview(tok_exp);
  assert r.status = 'EXPIRED' and r.email_matches, 'expired invitation is shown as expired';
  caught := false;
  begin perform public.accept_organization_invitation(tok_exp); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'an expired invitation cannot be accepted';
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  perform public.create_organization_invitation(org1, 'late@mi.local', 'MEMBER');
  reset role;
  select status into r from public.organization_invitations where id = inv_exp;
  assert r.status = 'EXPIRED', 're-inviting closes the expired invitation';
  set local role authenticated;

  perform set_config('request.jwt.claims', json_build_object('sub', a2, 'role', 'authenticated')::text, true);
  perform public.revoke_organization_invitation(inv_member);
  caught := false;
  begin perform public.revoke_organization_invitation(inv_member); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'revoking twice refused';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.revoke_organization_invitation(inv_admin); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot revoke (same error as unknown)';
  reset role;
  insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000001c4', 'worker@mi.local');
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', '00000000-0000-0000-0000-0000000001c4', 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.accept_organization_invitation(tok_member); exception when sqlstate '55000' then caught := true; end;
  assert caught, 'a revoked invitation cannot be accepted';

  ------------------------------------------------------------------ role changes
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.change_member_role(mem_m1, 'ADMIN'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot promote themselves';
  caught := false;
  begin update public.organization_members set role = 'OWNER' where id = mem_m1; exception when insufficient_privilege then caught := true; end;
  assert caught, 'direct role update refused';
  caught := false;
  begin insert into public.organization_members (organization_id, user_id, role) values (org2, m1, 'OWNER'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'direct membership insert refused';

  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.change_member_role(mem_m1, 'ADMIN'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an admin cannot change roles';
  caught := false;
  begin perform public.change_member_role(mem_o1, 'MEMBER'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an admin cannot demote the owner';

  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.change_member_role(mem_m1, 'ADMIN'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant''s owner cannot change org 1 roles';

  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.change_member_role(mem_o1, 'MEMBER'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the owner cannot change their own role';
  caught := false;
  begin perform public.change_member_role(mem_m1, 'OWNER'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'nobody can be made OWNER here';

  -- Before promotion m2 cannot create a department; after it, the new role applies to the next statement.
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_department(org1, 'Before'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot create departments';
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  perform public.change_member_role(mem_m2, 'ADMIN');
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform public.create_department(org1, 'After');
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  perform public.change_member_role(mem_m2, 'MEMBER');
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.create_department(org1, 'Demoted'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'a demotion takes effect immediately';

  ------------------------------------------------------------------ removal
  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.remove_organization_member(mem_a2); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an admin cannot remove another admin';
  caught := false;
  begin perform public.remove_organization_member(mem_o1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'nobody removes the owner';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.remove_organization_member(mem_m1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot remove org 1 members';
  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.remove_organization_member(mem_m1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot remove a colleague';

  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  perform public.remove_organization_member(mem_m1);
  reset role;
  select count(*) into n from public.department_members where user_id = m1;
  assert n = 0, 'removal clears department memberships';
  select count(*) into n from public.team_members where user_id = m1;
  assert n = 0, '...and team memberships';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.organizations where id = org1;
  assert n = 0, 'a removed member loses access at once';

  perform set_config('request.jwt.claims', json_build_object('sub', m2, 'role', 'authenticated')::text, true);
  perform public.remove_organization_member(mem_m2);
  perform set_config('request.jwt.claims', json_build_object('sub', o1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.organization_members where id = mem_m2;
  assert n = 0, 'an employee can leave';
  caught := false;
  begin perform public.remove_organization_member(mem_o1); exception when insufficient_privilege then caught := true; end;
  assert caught, 'the owner cannot leave';

  ------------------------------------------------------------------ audit trail
  select count(*) into n from public.organization_audit_events
  where organization_id = org1 and action in ('member.joined', 'member.role_changed', 'member.removed', 'member.left', 'member.invitation_revoked');
  assert n >= 6, 'membership changes are audited';
  select count(*) into n from public.organization_audit_events where organization_id = org1 and action = 'member.role_changed'
    and details ->> 'from' = 'MEMBER' and details ->> 'to' = 'ADMIN' and actor_id = o1;
  assert n = 1, 'audit records actor and change';
  perform set_config('request.jwt.claims', json_build_object('sub', u2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.organization_audit_events where organization_id = org1;
  assert n = 0, 'other tenants cannot read the audit trail';
  caught := false;
  begin insert into public.organization_audit_events (organization_id, action) values (org2, 'member.fake'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'clients cannot write audit events';

  reset role;
  raise notice 'ALL MEMBERSHIP CHECKS PASSED';
end;
$$;

rollback;
