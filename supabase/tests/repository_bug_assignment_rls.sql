-- Bug assignment (migration 20261029000003): who may assign, who is eligible, history, notifications, status authority.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_bug_assignment_rls.sql
set client_encoding = 'UTF8';
begin;
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000f101'; ma uuid := '00000000-0000-0000-0000-00000000f102';
  mb uuid := '00000000-0000-0000-0000-00000000f103'; mc uuid := '00000000-0000-0000-0000-00000000f104';
  owner2 uuid := '00000000-0000-0000-0000-00000000f201';
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; s1 uuid; scan uuid;
  bug uuid; n int; st text; cnt int; prof uuid;
  finding jsonb := jsonb_build_object('path', 'a.ts', 'start_line', 3, 'end_line', 4, 'title', 'Null dereference', 'description', 'row can be null',
    'category', 'backend', 'severity', 'HIGH', 'severity_reason', 'crashes', 'confidence', 0.8, 'evidence', 'return row.name',
    'suggested_fix', 'check row', 'validation_steps', 'call it', 'fingerprint', repeat('a', 40));
begin
  insert into auth.users (id, email) values (owner1,'fo1@f.local'),(ma,'fma@f.local'),(mb,'fmb@f.local'),(mc,'fmc@f.local'),(owner2,'fo2@f.local');
  insert into public.profiles (id, email) values (owner1,'fo1@f.local'),(ma,'fma@f.local'),(mb,'fmb@f.local'),(mc,'fmc@f.local'),(owner2,'fo2@f.local') on conflict do nothing;
  insert into public.organizations (name,slug,created_by) values ('Assign One','assign-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Assign Two','assign-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org1,mc,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb),(d1,mc);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(ta,mc),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/e/p','e','p','main',owner1) returning id into r1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'a.ts','TypeScript',1,repeat('1',64));
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id = s1;
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id = s1;
  -- Joining an organization creates the workforce profile; set what the ranking and eligibility look at.
  update public.workforce_profiles set availability = 'UNAVAILABLE', full_name = 'Carol C' where user_id = mc;
  update public.workforce_profiles set full_name = 'Alice A', job_title = 'Backend engineer' where user_id = ma;
  insert into public.skills (organization_id, name) values (org1, 'Node');
  insert into public.workforce_profile_skills (profile_id, skill_id) select w.id, k.id from public.workforce_profiles w, public.skills k where w.user_id = ma and k.organization_id = org1;

  set local role authenticated;
  perform public.zz_as(owner1);
  select public.start_bug_scan(s1, '{"batches":[{"units":[{"path":"a.ts"}]}]}'::jsonb, 1, 1) into scan;
  perform public.record_bug_scan_batch(scan, 0, jsonb_build_array(finding), false, 0, 0, 0, null);
  select id into bug from public.repository_bugs limit 1;

  -- Candidates: admin only; the member of the other team (mb) and the UNAVAILABLE colleague (mc) are not offered.
  perform public.zz_as(ma);
  begin perform * from public.list_bug_assignment_candidates(p1); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'members cannot list candidates';
  perform public.zz_as(owner1);
  select count(*) into cnt from public.list_bug_assignment_candidates(p1);
  assert cnt = 2, 'owner + ma only (got ' || cnt || ')';
  select count(*) into cnt from public.list_bug_assignment_candidates(p1) c where c.user_id = ma and c.on_project_team and c.skills = array['Node'];
  assert cnt = 1, 'candidate facts: team, skills';

  -- Manual assignment: admin only; eligibility is enforced by the database.
  perform public.zz_as(ma);
  begin perform public.assign_bug(bug, ma, 'MANUAL', 'self'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'members cannot assign';
  perform public.zz_as(owner1);
  foreach st in array array[mb::text, mc::text, owner2::text] loop
    begin perform public.assign_bug(bug, st::uuid, 'MANUAL', 'x'); st := 'none'; exception when others then st := sqlstate; end;
    assert st = '22023', 'ineligible assignee refused (got ' || st || ')';
  end loop;
  perform public.assign_bug(bug, ma, 'MANUAL', 'knows the module');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'ASSIGNED' and assigned_to = ma and assignment_source = 'MANUAL';
  assert cnt = 1, 'assigned';
  perform public.zz_as(ma);
  select count(*) into cnt from public.notifications where user_id = ma and type = 'bug.assigned'; assert cnt = 1, 'assignee notified';
  select count(*) into cnt from public.repository_bug_events where bug_id = bug and type = 'assigned' and details ->> 'source' = 'MANUAL'; assert cnt = 1, 'history';

  -- The assignee works the bug; others cannot move it; the admin can reassign (automatic source) and history grows.
  perform public.transition_bug(bug, 'IN_PROGRESS', null);
  perform public.zz_as(mb);
  begin perform public.transition_bug(bug, 'BLOCKED', 'because'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'a member of another team cannot even see the bug (got ' || st || ')';
  perform public.zz_as(ma);
  begin perform public.transition_bug(bug, 'RESOLVED', 'done'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'resolved is not allowed from in progress (got ' || st || ')';
  begin perform public.transition_bug(bug, 'REJECTED', 'not a bug'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000' or st = '42501', 'assignees cannot reject (got ' || st || ')';
  begin perform public.transition_bug(bug, 'BLOCKED', ''); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'blocking needs a reason';
  perform public.transition_bug(bug, 'BLOCKED', 'waiting for the API owner');
  perform public.zz_as(owner1);
  select count(*) into cnt from public.notifications where user_id = owner1 and type = 'bug.blocked'; assert cnt = 1, 'admins are told about a blocked bug';
  perform public.assign_bug(bug, owner1, 'AUTO', 'ranked first');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'ASSIGNED' and assigned_to = owner1 and assignment_source = 'AUTO'; assert cnt = 1, 'reassigned automatically';
  perform public.zz_as(ma);
  select count(*) into cnt from public.notifications where user_id = ma and type = 'bug.unassigned'; assert cnt = 1, 'previous assignee told';
  perform public.zz_as(owner1);
  perform public.unassign_bug(bug, 'back to triage');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'TRIAGED' and assigned_to is null; assert cnt = 1, 'unassigned';
  select count(*) into cnt from public.repository_bug_events where bug_id = bug and type in ('assigned', 'unassigned'); assert cnt = 3, 'full assignment history (' || cnt || ')';

  -- Reject/cancel/reopen are admin-only and need a reason; comments are open to people who can see the project.
  begin perform public.transition_bug(bug, 'REJECTED', ''); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'rejecting needs a reason';
  perform public.transition_bug(bug, 'REJECTED', 'false positive: guarded upstream');
  perform public.transition_bug(bug, 'REOPENED', 'seen again');
  perform public.zz_as(ma); perform public.add_bug_comment(bug, 'Looking at this');
  perform public.zz_as(mb);
  begin perform public.add_bug_comment(bug, 'hi'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'no comments from people who cannot see the project';
  perform public.zz_as(owner2);
  begin perform public.assign_bug(bug, owner2, 'MANUAL', 'x'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'other organization cannot assign';
end $$;
rollback;
select 'repository_bug_assignment_rls: ok' as result;
