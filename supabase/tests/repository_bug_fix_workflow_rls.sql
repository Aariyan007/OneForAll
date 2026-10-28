-- Fix workflow (migration 20261029000004): proposal integrity, approval, validation, and the evidence-gated stages.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_bug_fix_workflow_rls.sql
set client_encoding = 'UTF8';
begin;
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000a101'; ma uuid := '00000000-0000-0000-0000-00000000a102';
  mb uuid := '00000000-0000-0000-0000-00000000a103'; mc uuid := '00000000-0000-0000-0000-00000000a104';
  org1 uuid; d1 uuid; ta uuid; tb uuid; p1 uuid; r1 uuid; s1 uuid; scan uuid; bug uuid; fix1 uuid; fix2 uuid;
  st text; cnt int; patched text := 'return row?.name;'; ph text; goodhash text := repeat('1', 64);
  files jsonb;
  finding jsonb := jsonb_build_object('path', 'a.ts', 'start_line', 3, 'end_line', 4, 'title', 'Null dereference', 'description', 'row can be null',
    'category', 'backend', 'severity', 'HIGH', 'severity_reason', 'crashes', 'confidence', 0.8, 'evidence', 'return row.name',
    'suggested_fix', 'check row', 'validation_steps', 'call it', 'fingerprint', repeat('a', 40));
begin
  insert into auth.users (id, email) values (owner1,'wo1@w.local'),(ma,'wma@w.local'),(mb,'wmb@w.local'),(mc,'wmc@w.local');
  insert into public.profiles (id, email) values (owner1,'wo1@w.local'),(ma,'wma@w.local'),(mb,'wmb@w.local'),(mc,'wmc@w.local') on conflict do nothing;
  insert into public.organizations (name,slug,created_by) values ('Flow One','flow-one',owner1) returning id into org1;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org1,mc,'MEMBER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb),(d1,mc);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.team_members (team_id,user_id) values (ta,ma),(ta,mc),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/e/p','e','p','main',owner1) returning id into r1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'a.ts','TypeScript',1,goodhash);
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id = s1;
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id = s1;
  ph := encode(sha256(convert_to(patched, 'UTF8')), 'hex');
  files := jsonb_build_array(jsonb_build_object('path', 'a.ts', 'base_hash', goodhash, 'patched_content', patched, 'patched_hash', ph));

  set local role authenticated;
  perform public.zz_as(owner1);
  select public.start_bug_scan(s1, '{"batches":[{"units":[{"path":"a.ts"}]}]}'::jsonb, 1, 1) into scan;
  perform public.record_bug_scan_batch(scan, 0, jsonb_build_array(finding), false, 0, 0, 0, null);
  select id into bug from public.repository_bugs limit 1;
  perform public.assign_bug(bug, ma, 'MANUAL', 'test');

  -- A fix cannot be proposed before work has started, nor by someone who is not the assignee.
  perform public.zz_as(ma);
  begin perform public.propose_bug_fix(bug, '{"summary":"s"}', '[]', 'diff', files, 'm', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'no fix before work starts (got ' || st || ')';
  perform public.transition_bug(bug, 'IN_PROGRESS', null);
  perform public.zz_as(mc);
  begin perform public.propose_bug_fix(bug, '{"summary":"s"}', '[]', 'diff', files, 'm', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'a colleague cannot propose (got ' || st || ')';

  -- Integrity: the patch must be based on the stored file, and the patched hash must match the content.
  perform public.zz_as(ma);
  begin perform public.propose_bug_fix(bug, '{"summary":"s"}', '[]', 'diff', jsonb_build_array(jsonb_build_object('path','a.ts','base_hash',repeat('9',64),'patched_content',patched,'patched_hash',ph)), 'm', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'wrong base hash refused (got ' || st || ')';
  begin perform public.propose_bug_fix(bug, '{"summary":"s"}', '[]', 'diff', jsonb_build_array(jsonb_build_object('path','a.ts','base_hash',goodhash,'patched_content',patched,'patched_hash',repeat('0',64))), 'm', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'forged patched hash refused (got ' || st || ')';
  begin perform public.propose_bug_fix(bug, '{"summary":"s"}', '[]', 'diff', jsonb_build_array(jsonb_build_object('path','nope.ts','base_hash',goodhash,'patched_content',patched,'patched_hash',ph)), 'm', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'unknown file refused (got ' || st || ')';

  select public.propose_bug_fix(bug, '{"summary":"guard row"}', '[{"path":"a.ts"}]', '--- a/a.ts', files, 'gemini', null) into fix1;
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'AWAITING_APPROVAL'; assert cnt = 1, 'awaiting approval';

  -- Only the assignee or an admin decides; reject sends it back; a new proposal supersedes nothing that was decided.
  perform public.zz_as(mc);
  begin perform public.decide_bug_fix(fix1, 'APPROVE', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'a colleague cannot approve (got ' || st || ')';
  perform public.zz_as(ma);
  begin perform public.decide_bug_fix(fix1, 'REJECT', ''); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'rejecting needs a reason';
  begin perform public.record_bug_fix_validation(fix1, '{"passed":true,"checks":[{"name":"syntax","status":"PASS"}]}'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'nothing is applied without approval (got ' || st || ')';
  perform public.decide_bug_fix(fix1, 'REQUEST_CHANGES', 'handle undefined too');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'IN_PROGRESS'; assert cnt = 1, 'changes requested -> back to in progress';

  select public.propose_bug_fix(bug, '{"summary":"guard row v2"}', '[{"path":"a.ts"}]', '--- a/a.ts v2', files, 'gemini', null) into fix2;
  select count(*) into cnt from public.repository_bug_fixes where bug_id = bug and version = 2; assert cnt = 1, 'version 2';
  perform public.decide_bug_fix(fix2, 'APPROVE', null);
  -- A validation that claims success while a check failed is refused; a failed validation sends the bug back.
  begin perform public.record_bug_fix_validation(fix2, '{"passed":true,"checks":[{"name":"syntax","status":"FAIL"}]}'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'contradictory validation refused (got ' || st || ')';
  perform public.record_bug_fix_validation(fix2, '{"passed":false,"checks":[{"name":"syntax","status":"FAIL","detail":"parse error"}]}');
  select count(*) into cnt from public.repository_bug_fixes where id = fix2 and status = 'VALIDATION_FAILED'; assert cnt = 1, 'validation failed recorded';
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'IN_PROGRESS'; assert cnt = 1, 'validation failed -> in progress';

  select public.propose_bug_fix(bug, '{"summary":"guard row v3"}', '[{"path":"a.ts"}]', '--- a/a.ts v3', files, 'gemini', null) into fix2;
  perform public.decide_bug_fix(fix2, 'APPROVE', null);
  perform public.record_bug_fix_validation(fix2, '{"passed":true,"checks":[{"name":"patch applies","status":"PASS"},{"name":"syntax","status":"PASS"},{"name":"tests","status":"SKIPPED"}]}');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'FIX_APPLIED'; assert cnt = 1, 'fix applied';

  -- Stages: no shortcut to resolved; evidence is required; the fixer cannot review or verify their own fix.
  begin perform public.transition_bug(bug, 'RESOLVED', 'looks good to me, thanks'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'applied -> resolved is not allowed (got ' || st || ')';
  perform public.transition_bug(bug, 'TESTING', null);
  begin perform public.transition_bug(bug, 'CODE_REVIEW', 'ok'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'review request needs test evidence (got ' || st || ')';
  perform public.transition_bug(bug, 'CODE_REVIEW', 'Ran the cart tests: 12 passed, 0 failed; added a missing-row case.');
  perform public.zz_as(mc);
  select count(*) into cnt from public.notifications where user_id = mc and type = 'bug.review_requested'; assert cnt = 1, 'reviewers are asked';
  perform public.zz_as(ma);
  begin perform public.transition_bug(bug, 'QA_VERIFICATION', 'I reviewed my own work, fine'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'the fixer cannot review their own fix (got ' || st || ')';
  perform public.zz_as(mb);
  begin perform public.transition_bug(bug, 'QA_VERIFICATION', 'outsider review ok'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'someone who cannot see the project cannot review (got ' || st || ')';
  perform public.zz_as(mc);
  begin perform public.transition_bug(bug, 'QA_VERIFICATION', 'ok'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'review outcome needs a description';
  perform public.transition_bug(bug, 'QA_VERIFICATION', 'Reviewed the diff: guard is correct and covers undefined and null.');
  perform public.zz_as(ma);
  begin perform public.transition_bug(bug, 'RESOLVED', 'I verified it myself, all good'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'the fixer cannot verify their own fix (got ' || st || ')';
  perform public.zz_as(mc);
  begin perform public.transition_bug(bug, 'RESOLVED', 'fine'); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'verification needs evidence';
  perform public.transition_bug(bug, 'RESOLVED', 'Reproduced the original crash on the old build; the fixed build returns undefined instead.');
  select count(*) into cnt from public.repository_bugs where id = bug and status = 'RESOLVED'; assert cnt = 1, 'resolved';
  perform public.zz_as(ma);
  select count(*) into cnt from public.notifications where user_id = ma and type = 'bug.resolved'; assert cnt = 1, 'assignee told';

  -- History and reads.
  select count(*) into cnt from public.repository_bug_events where bug_id = bug and type in ('fix_proposed', 'fix_approved', 'fix_changes_requested', 'fix_validation_failed', 'fix_applied', 'status_changed');
  assert cnt >= 9, 'fix history recorded (' || cnt || ')';
  select count(*) into cnt from public.repository_bug_fixes; assert cnt = 3, 'assignee sees the fixes';
  select count(*) into cnt from public.repository_bug_fix_files; assert cnt = 3, 'and the patched files';
  perform public.zz_as(mb);
  select count(*) into cnt from public.repository_bug_fixes; assert cnt = 0, 'another team sees nothing';
  select count(*) into cnt from public.repository_bug_fix_files; assert cnt = 0, 'nor the patched files';
  begin update public.repository_bug_fixes set status = 'APPLIED'; st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'no direct writes';
end $$;
rollback;
select 'repository_bug_fix_workflow_rls: ok' as result;
