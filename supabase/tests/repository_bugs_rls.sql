-- Bug scans and bugs (migration 20261029000002): who may scan, de-duplication, idempotent batches, reopen, RLS reads.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_bugs_rls.sql
set client_encoding = 'UTF8';
begin;
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;
do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000e101'; ma uuid := '00000000-0000-0000-0000-00000000e102';
  mb uuid := '00000000-0000-0000-0000-00000000e103'; owner2 uuid := '00000000-0000-0000-0000-00000000e201';
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; rx uuid;
  s1 uuid; sx uuid; scan uuid; scan2 uuid; res jsonb; n int; st text; bug uuid;
  finding jsonb := jsonb_build_object('path', 'a.ts', 'start_line', 3, 'end_line', 4, 'title', 'Null dereference', 'description', 'row can be null',
    'category', 'backend', 'severity', 'HIGH', 'severity_reason', 'crashes the request', 'confidence', 0.8, 'evidence', 'return row.name',
    'suggested_fix', 'check row', 'validation_steps', 'call with a missing id', 'fingerprint', repeat('a', 40));
begin
  insert into auth.users (id, email) values (owner1,'eo1@e.local'),(ma,'ema@e.local'),(mb,'emb@e.local'),(owner2,'eo2@e.local');
  insert into public.organizations (name,slug,created_by) values ('Bugs One','bugs-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Bugs Two','bugs-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/e/p','e','p','main',owner1) returning id into r1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (px,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into rx;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (rx,repeat('a',40),'main') returning id into sx;
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (s1,'a.ts','TypeScript',1,repeat('1',64));
  insert into public.repository_files (snapshot_id,path,language,size_bytes,content_hash) values (sx,'x.ts','TypeScript',1,repeat('9',64));
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id in (s1, sx);
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id in (s1, sx);

  assert (select prosecdef from pg_proc where oid = 'public.record_bug_scan_batch(uuid,integer,jsonb,boolean,bigint,bigint,numeric,text)'::regprocedure), 'definer';
  assert not has_function_privilege('anon', 'public.start_bug_scan(uuid,jsonb,integer,integer)', 'execute'), 'anon cannot start scans';
  assert not has_table_privilege('authenticated', 'public.repository_bugs', 'insert'), 'no client insert';
  assert not has_table_privilege('authenticated', 'public.repository_bugs', 'update'), 'no client update';
  assert (select relrowsecurity from pg_class where oid = 'public.repository_bugs'::regclass), 'RLS on bugs';
  set local role authenticated;

  -- Only organization owners and admins may scan; other members and other organizations get "not found".
  foreach st in array array[ma::text, mb::text, owner2::text] loop
    perform public.zz_as(st::uuid);
    begin perform public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]}]}'::jsonb, 1, 1); st := 'none';
    exception when others then st := sqlstate; end;
    assert st = '42501', 'scan denied for non-admins (got ' || st || ')';
  end loop;

  perform public.zz_as(owner1);
  begin perform public.start_bug_scan(s1, '[]'::jsonb, 1, 1); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '22023', 'invalid plan rejected';
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]},{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan;
  begin perform public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]}]}'::jsonb, 1, 1); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'one running scan per snapshot';

  -- Batch 0 stores a bug; the same batch again is a no-op (idempotent).
  select public.record_bug_scan_batch(scan, 0, jsonb_build_array(finding), false, 1000, 200, 0.0012, null) into res;
  assert (res ->> 'new')::int = 1, 'one new bug';
  select public.record_bug_scan_batch(scan, 0, jsonb_build_array(finding), false, 1000, 200, 0.0012, null) into res;
  assert (res ->> 'duplicate')::boolean, 'a retried batch is ignored';
  select count(*) into n from public.repository_bugs; assert n = 1, 'one bug stored';
  select bugs_new, array_length(completed_batches, 1) into n, st from public.repository_bug_scans where id = scan;

  -- A finding for a file that is not in the snapshot is skipped, not stored.
  select public.record_bug_scan_batch(scan, 1, jsonb_build_array(finding || '{"path":"nope.ts","fingerprint":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}'::jsonb), false, 0, 0, 0, null) into res;
  assert (res ->> 'skipped')::int = 1, 'unknown file skipped';
  select status into st from public.repository_bug_scans where id = scan; assert st = 'COMPLETED', 'scan completes when all batches are in (got ' || st || ')';
  begin perform public.record_bug_scan_batch(scan, 1, '[]'::jsonb, false, 0, 0, 0, null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '55000', 'a finished scan accepts no more batches';

  -- A second scan sees the same bug again: no duplicate row, counter goes up, event logged.
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan2;
  select public.record_bug_scan_batch(scan2, 0, jsonb_build_array(finding), false, 10, 10, 0, null) into res;
  assert (res ->> 'seen_again')::int = 1 and (res ->> 'new')::int = 0, 'seen again, not new';
  select count(*), max(times_seen) into n, st from public.repository_bugs; assert n = 1 and st = '2', 'still one bug, seen twice';
  select count(*) into n from public.repository_bug_events where type = 'rescanned'; assert n = 1, 'rescan event';

  -- A failed batch marks the scan PARTIAL / FAILED honestly.
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan;
  select public.record_bug_scan_batch(scan, 0, '[]'::jsonb, true, 0, 0, 0, 'model unavailable') into res;
  select status into st from public.repository_bug_scans where id = scan; assert st = 'FAILED', 'all batches failed -> FAILED (got ' || st || ')';

  -- Cancelling a running scan keeps what it found.
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]},{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan;
  perform public.record_bug_scan_batch(scan, 0, '[]'::jsonb, false, 0, 0, 0, null);
  perform public.finish_bug_scan(scan, 'CANCELLED', 'Cancelled by the user.');
  select status into st from public.repository_bug_scans where id = scan; assert st = 'CANCELLED', 'cancelled';

  -- Resume: finished batches are kept, failed ones are tried again, members cannot resume.
  perform public.zz_as(ma);
  begin perform public.resume_bug_scan(scan); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'members cannot resume';
  perform public.zz_as(owner1);
  perform public.resume_bug_scan(scan);
  select status into st from public.repository_bug_scans where id = scan; assert st = 'RUNNING', 'resumed';
  perform public.finish_bug_scan(scan, 'CANCELLED', null);
  select count(*) into n from public.repository_bug_scans where status = 'FAILED';
  assert n = 1, 'the earlier failed scan stays failed until resumed';
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan2;
  perform public.record_bug_scan_batch(scan2, 0, '[]'::jsonb, true, 0, 0, 0, 'boom');
  perform public.resume_bug_scan(scan2);
  select count(*) into n from public.repository_bug_scans where id = scan2 and status = 'RUNNING' and failed_batches = '{}'; assert n = 1, 'failed batch cleared for retry';
  perform public.record_bug_scan_batch(scan2, 0, '[]'::jsonb, false, 0, 0, 0, null);
  select status into st from public.repository_bug_scans where id = scan2; assert st = 'COMPLETED', 'retry completes the scan';

  -- An owner of ANOTHER organization is not a member here: every scan function must say "not found" (a NULL role must
  -- never slip through a NOT IN check).
  perform public.zz_as(owner1);
  select public.start_bug_scan(s1, '{"batches":[{"paths":["a.ts"]},{"paths":["a.ts"]}]}'::jsonb, 1, 1) into scan;
  perform public.zz_as(owner2);
  begin perform public.record_bug_scan_batch(scan, 0, '[]'::jsonb, false, 0, 0, 0, null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'outsider cannot record batches (got ' || st || ')';
  begin perform public.finish_bug_scan(scan, 'CANCELLED', null); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'outsider cannot cancel scans (got ' || st || ')';
  begin perform public.resume_bug_scan(scan); st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'outsider cannot resume scans (got ' || st || ')';
  perform public.zz_as(owner1);
  perform public.finish_bug_scan(scan, 'CANCELLED', null);

  -- Reads: owner sees it; the team-A member sees it; the member of another team and the other organization do not.
  select id into bug from public.repository_bugs limit 1;
  perform public.zz_as(ma); select count(*) into n from public.repository_bugs; assert n = 1, 'team member sees the bug';
  select count(*) into n from public.repository_bug_events; assert n >= 2, 'team member sees its history';
  perform public.zz_as(mb); select count(*) into n from public.repository_bugs; assert n = 0, 'member of another team sees nothing';
  select count(*) into n from public.repository_bug_scans; assert n = 0, 'nor the scans';
  select count(*) into n from public.repository_bug_events; assert n = 0, 'nor the events';
  perform public.zz_as(owner2); select count(*) into n from public.repository_bugs; assert n = 0, 'other organization sees nothing';

  -- Direct writes are impossible for everyone, including the owner.
  perform public.zz_as(owner1);
  begin update public.repository_bugs set status = 'RESOLVED' where id = bug; st := 'none'; exception when others then st := sqlstate; end;
  assert st = '42501', 'no direct update (got ' || st || ')';

  -- The transition table: resolved only after QA verification.
  reset role;
  assert private.bug_transition_ok('QA_VERIFICATION', 'RESOLVED'), 'qa -> resolved';
  assert not private.bug_transition_ok('FIX_APPLIED', 'RESOLVED'), 'fix -> resolved is not allowed';
end $$;
rollback;
select 'repository_bugs_rls: ok' as result;
