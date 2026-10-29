-- "My bugs": a bug an admin assigns must reach the assignee's own queue, and only theirs (migration 20261029000003 + RLS of 20261029000002).
-- The `queue` helper below runs the same filters as getMyBugs() in src/server/bugs/overview.ts, as the signed-in user, so
-- it exercises row-level security exactly as the application does.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_bug_my_queue_rls.sql
set client_encoding = 'UTF8';
begin;
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
-- Open = every status except the closed ones (OPEN_BUG_STATUSES in src/lib/bugs/model.ts).
create function public.zz_queue(p_user uuid) returns integer language sql stable as $$
  select count(*)::int from public.repository_bugs b
  where b.assigned_to = p_user
    and b.status in ('DETECTED', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'FIX_PROPOSED', 'AWAITING_APPROVAL', 'FIX_APPLIED', 'TESTING',
                     'CODE_REVIEW', 'QA_VERIFICATION', 'BLOCKED', 'REOPENED');
$$;
create function public.zz_review_queue() returns integer language sql stable as $$
  select count(*)::int from public.repository_bugs b where b.status in ('CODE_REVIEW', 'QA_VERIFICATION');
$$;
do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000a101'; ma uuid := '00000000-0000-0000-0000-00000000a102';
  mb uuid := '00000000-0000-0000-0000-00000000a103'; mc uuid := '00000000-0000-0000-0000-00000000a104';
  owner2 uuid := '00000000-0000-0000-0000-00000000a201';
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; s1 uuid; scan uuid;
  bug uuid; cnt int; st text; s text;
  finding jsonb := jsonb_build_object('path', 'a.ts', 'start_line', 3, 'end_line', 4, 'title', 'Null dereference', 'description', 'row can be null',
    'category', 'backend', 'severity', 'HIGH', 'severity_reason', 'crashes', 'confidence', 0.8, 'evidence', 'return row.name',
    'suggested_fix', 'check row', 'validation_steps', 'call it', 'fingerprint', repeat('a', 40));
begin
  insert into auth.users (id, email) values (owner1,'qo1@q.local'),(ma,'qma@q.local'),(mb,'qmb@q.local'),(mc,'qmc@q.local'),(owner2,'qo2@q.local');
  insert into public.profiles (id, email) values (owner1,'qo1@q.local'),(ma,'qma@q.local'),(mb,'qmb@q.local'),(mc,'qmc@q.local'),(owner2,'qo2@q.local') on conflict do nothing;
  insert into public.organizations (name,slug,created_by) values ('Queue One','queue-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Queue Two','queue-two',owner2) returning id into org2;
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

  set local role authenticated;
  perform public.zz_as(owner1);
  select public.start_bug_scan(s1, '{"batches":[{"units":[{"path":"a.ts"}]}]}'::jsonb, 1, 1) into scan;
  perform public.record_bug_scan_batch(scan, 0, jsonb_build_array(finding), false, 0, 0, 0, null);
  select id into bug from public.repository_bugs limit 1;

  -- Before any assignment nobody has it in their queue.
  perform public.zz_as(ma); assert public.zz_queue(ma) = 0, 'nothing assigned yet';

  -- 1 + 2. The admin assigns; the assignee's own query returns the bug and its current assignment is stored on the bug row.
  perform public.zz_as(owner1);
  perform public.assign_bug(bug, ma, 'MANUAL', 'knows the module');
  perform public.zz_as(ma);
  assert public.zz_queue(ma) = 1, 'the assignee sees the assigned bug in their queue';
  select count(*) into cnt from public.repository_bugs b where b.id = bug and b.assigned_to = ma and b.status = 'ASSIGNED' and b.assigned_at is not null and b.assigned_by = owner1;
  assert cnt = 1, 'the current assignment is on the bug row (not only in history)';
  select count(*) into cnt from public.repository_bug_events e where e.bug_id = bug and e.type = 'assigned'; assert cnt = 1, 'the assignee can read the history';
  select count(*) into cnt from public.notifications n where n.user_id = ma and n.type = 'bug.assigned' and n.link like '%/bugs/' || bug; assert cnt = 1, 'the notification points at this bug';

  -- 4. A colleague who CAN see the project does not get it as assigned work; a member of another team cannot see it at all.
  perform public.zz_as(mc);
  select count(*) into cnt from public.repository_bugs where id = bug; assert cnt = 1, 'a colleague on the project team can see the bug';
  assert public.zz_queue(mc) = 0, 'but it is not in their assigned queue';
  perform public.zz_as(mb);
  select count(*) into cnt from public.repository_bugs where id = bug; assert cnt = 0, 'a member of another team cannot see it';
  assert public.zz_queue(mb) = 0, 'and has nothing assigned';

  -- 5. Another organization sees nothing and cannot act on it.
  perform public.zz_as(owner2);
  select count(*) into cnt from public.repository_bugs where id = bug; assert cnt = 0, 'another organization cannot read the bug';
  select count(*) into cnt from public.repository_bug_events where bug_id = bug; assert cnt = 0, 'nor its history';
  begin perform public.assign_bug(bug, owner2, 'MANUAL', 'x'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'another organization cannot assign it (got ' || st || ')';

  -- 7. Every actionable status keeps the bug in the assignee's queue; closed ones drop it. Statuses are set directly (as the
  -- table owner) to exercise the filter, not the workflow, which has its own suite.
  foreach s in array array['ASSIGNED', 'IN_PROGRESS', 'FIX_PROPOSED', 'AWAITING_APPROVAL', 'FIX_APPLIED', 'TESTING', 'CODE_REVIEW', 'QA_VERIFICATION', 'BLOCKED', 'REOPENED'] loop
    reset role;
    update public.repository_bugs set status = s where id = bug;
    set local role authenticated;
    perform public.zz_as(ma);
    assert public.zz_queue(ma) = 1, s || ' must stay in the assignee''s queue';
  end loop;
  -- Bugs in review or QA also show to colleagues who can see the project (the "to review" list), but not in their assigned queue.
  reset role; update public.repository_bugs set status = 'CODE_REVIEW' where id = bug; set local role authenticated;
  perform public.zz_as(mc);
  assert public.zz_review_queue() = 1, 'a colleague sees the bug waiting for review';
  assert public.zz_queue(mc) = 0, 'which is still not assigned to them';
  perform public.zz_as(mb);
  assert public.zz_review_queue() = 0, 'a member of another team does not see it';

  -- 6. A resolved bug leaves the active queue.
  foreach s in array array['RESOLVED', 'REJECTED', 'CANCELLED'] loop
    reset role;
    update public.repository_bugs set status = s where id = bug;
    set local role authenticated;
    perform public.zz_as(ma);
    assert public.zz_queue(ma) = 0, s || ' must not be active work';
  end loop;

  -- 9. Reassignment moves the CURRENT assignee and keeps the history; the previous assignee loses it.
  reset role; update public.repository_bugs set status = 'IN_PROGRESS' where id = bug; set local role authenticated;
  perform public.zz_as(owner1);
  perform public.assign_bug(bug, mc, 'MANUAL', 'taking over');
  perform public.zz_as(mc); assert public.zz_queue(mc) = 1, 'the new assignee has it';
  perform public.zz_as(ma); assert public.zz_queue(ma) = 0, 'the previous assignee no longer has it as current work';
  select count(*) into cnt from public.repository_bug_events e where e.bug_id = bug and e.type = 'assigned'; assert cnt = 2, 'both assignments are in the history';
  select count(*) into cnt from public.repository_bug_events e where e.bug_id = bug and e.type = 'assigned' and e.details ->> 'previous_assignee' = ma::text and e.details ->> 'assignee' = mc::text;
  assert cnt = 1, 'the history records who it moved from and to';

  -- 10. Automatic assignment goes through the same function and lands in the chosen person's queue.
  perform public.zz_as(owner1);
  perform public.assign_bug(bug, ma, 'AUTO', 'ranked first');
  perform public.zz_as(ma); assert public.zz_queue(ma) = 1, 'the automatically chosen assignee sees it';
  select count(*) into cnt from public.repository_bugs b where b.id = bug and b.assignment_source = 'AUTO' and b.assigned_to = ma; assert cnt = 1, 'source recorded as AUTO';
  perform public.zz_as(mc); assert public.zz_queue(mc) = 0, 'and the previous assignee lost it';
end $$;
rollback;
select 'repository_bug_my_queue_rls: ok' as result;
