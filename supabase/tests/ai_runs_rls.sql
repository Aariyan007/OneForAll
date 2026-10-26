-- AI runs (migration 20261028000003): privileges, who may start a run, quotas, lifecycle transitions, finishing,
-- cancellation, the per-organization switch and RLS reads. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/ai_runs_rls.sql

set client_encoding = 'UTF8';
begin;

create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000a101';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-00000000a104';  -- ADMIN of org 1
  ma     uuid := '00000000-0000-0000-0000-00000000a102';  -- MEMBER, team A (sees the project)
  mb     uuid := '00000000-0000-0000-0000-00000000a103';  -- MEMBER, team B (does not)
  owner2 uuid := '00000000-0000-0000-0000-00000000a201';  -- OWNER of org 2 (other tenant)
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid; r1 uuid; rx uuid;
  s1 uuid; sp uuid; sx uuid; run1 uuid; run2 uuid; run3 uuid;
  r record; n int; st text; fn text; ok boolean;
begin
  insert into auth.users (id, email) values (owner1,'ao1@a.local'),(admin1,'aa1@a.local'),(ma,'ama@a.local'),(mb,'amb@a.local'),(owner2,'ao2@a.local');
  insert into public.organizations (name,slug,created_by) values ('AI One','ai-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('AI Two','ai-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role)
    values (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/a/p','a','p','main',owner1) returning id into r1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (px,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into rx;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('b',40),'main') returning id into sp;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (rx,repeat('a',40),'main') returning id into sx;
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id in (s1, sx);
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id in (s1, sx);

  ---------------------------------------------------------------- catalog
  foreach fn in array array['public.start_ai_run(uuid,text,jsonb)', 'public.record_ai_run_state(uuid,text,jsonb)',
                            'public.finish_ai_run(uuid,text,jsonb,text,text,jsonb)', 'public.request_ai_run_cancel(uuid)',
                            'public.set_ai_enabled(uuid,boolean)'] loop
    select p.prosecdef, p.proconfig into r from pg_proc p where p.oid = fn::regprocedure;
    assert r.prosecdef, fn || ': SECURITY DEFINER';
    assert r.proconfig @> array['search_path=""'], fn || ': empty search_path';
    assert has_function_privilege('authenticated', fn, 'execute'), fn || ': authenticated can execute';
    assert not has_function_privilege('anon', fn, 'execute'), fn || ': anon cannot execute';
  end loop;
  foreach fn in array array['public.ai_runs', 'public.ai_run_events'] loop
    assert (select relrowsecurity from pg_class where oid = fn::regclass), fn || ': RLS enabled';
    assert not has_table_privilege('authenticated', fn, 'insert'), fn || ': no client INSERT';
    assert not has_table_privilege('authenticated', fn, 'update'), fn || ': no client UPDATE';
    assert not has_table_privilege('authenticated', fn, 'delete'), fn || ': no client DELETE';
    assert not has_table_privilege('anon', fn, 'select'), fn || ': no anon SELECT';
  end loop;

  set local role authenticated;

  ---------------------------------------------------------------- start: who may
  perform public.zz_as(ma);
  select * into r from public.start_ai_run(s1, 'code_qa', '{"question":"Where?"}'::jsonb);
  run1 := r.run_id;
  assert run1 is not null and r.correlation_id is not null, 'a team member who sees the project can start a run';
  select status into st from public.ai_runs where id = run1;
  assert st = 'queued', 'a new run is queued';

  foreach fn in array array[mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    st := null;
    begin perform public.start_ai_run(s1, 'code_qa', '{"question":"x"}'::jsonb); exception when others then st := sqlstate; end;
    assert st = '42501', 'start denied for ' || fn || ' (got ' || coalesce(st, 'none') || ')';
  end loop;

  perform public.zz_as(owner1);
  st := null;
  begin perform public.start_ai_run(sp, 'code_qa', '{"question":"x"}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '55000', 'a snapshot that is not COMPLETED is refused';
  st := null;
  begin perform public.start_ai_run(s1, 'delete_everything', '{}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '22023', 'unknown job type refused';
  st := null;
  begin perform public.start_ai_run(s1, 'code_qa', jsonb_build_object('q', repeat('x', 20000))); exception when others then st := sqlstate; end;
  assert st = '22023', 'oversized input refused';

  ---------------------------------------------------------------- lifecycle: valid and invalid transitions, owner only
  perform public.zz_as(ma);
  perform public.record_ai_run_state(run1, 'validating', null);
  perform public.record_ai_run_state(run1, 'retrieving_context', null);
  perform public.record_ai_run_state(run1, 'generating', '{"tier":"fast","model":"m"}'::jsonb);
  st := null;
  begin perform public.record_ai_run_state(run1, 'queued', null); exception when others then st := sqlstate; end;
  assert st = '55000', 'generating -> queued is not a valid transition';
  st := null;
  begin perform public.record_ai_run_state(run1, 'completed', null); exception when others then st := sqlstate; end;
  assert st = '22023', 'terminal states are recorded only with finish_ai_run';

  perform public.zz_as(owner1);
  st := null;
  begin perform public.record_ai_run_state(run1, 'executing_tool', null); exception when others then st := sqlstate; end;
  assert st = '42501', 'only the requester records progress, not even the owner';

  ---------------------------------------------------------------- concurrency quota
  perform public.zz_as(ma);
  select run_id into run2 from public.start_ai_run(s1, 'code_qa', '{"question":"two"}'::jsonb);
  st := null;
  begin perform public.start_ai_run(s1, 'code_qa', '{"question":"three"}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '54000', 'at most 2 active runs per user';

  ---------------------------------------------------------------- finish
  perform public.record_ai_run_state(run1, 'validating_output', null);
  perform public.finish_ai_run(run1, 'completed', '{"answer":"ok","citations":[]}'::jsonb, null, null,
    '{"input_tokens":120,"output_tokens":30,"cached_input_tokens":0,"thinking_tokens":5,"estimated_cost_usd":0.0002,"model_calls":2,"tool_calls":1,"attempts":2,"fallback_used":false,"citations_dropped":0,"context_tokens_estimate":900,"tier":"fast","model":"gemini-3.5-flash-lite"}'::jsonb);
  select * into r from public.ai_runs where id = run1;
  assert r.status = 'completed' and r.input_tokens = 120 and r.tool_calls = 1 and r.model = 'gemini-3.5-flash-lite' and r.completed_at is not null, 'finish records the outcome and metrics';
  st := null;
  begin perform public.finish_ai_run(run1, 'failed', null, 'internal', 'x', '{}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '55000', 'a finished run cannot be finished again';
  st := null;
  begin perform public.finish_ai_run(run2, 'completed', '{}'::jsonb, null, null, '{}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '55000', 'queued -> completed is not a valid transition';
  st := null;
  begin perform public.finish_ai_run(run2, 'failed', null, 'Robert''); drop', 'x', '{}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '22023', 'error category must be a plain code';
  perform public.finish_ai_run(run2, 'failed', null, 'not_configured', 'The AI assistant is not configured.', '{}'::jsonb);

  ---------------------------------------------------------------- cancellation
  select run_id into run3 from public.start_ai_run(s1, 'code_review', '{"mode":"review","path":"a.ts"}'::jsonb);
  perform public.zz_as(mb);
  st := null;
  begin perform public.request_ai_run_cancel(run3); exception when others then st := sqlstate; end;
  assert st = '42501', 'another member cannot cancel';
  perform public.zz_as(admin1);
  select public.request_ai_run_cancel(run3) into ok;
  assert ok, 'an admin can cancel';
  perform public.zz_as(ma);
  select cancel_requested into ok from public.ai_runs where id = run3;
  assert ok, 'the requester sees the cancel request';
  perform public.finish_ai_run(run3, 'cancelled', null, 'cancelled', 'Cancelled.', '{}'::jsonb);

  ---------------------------------------------------------------- reads
  perform public.zz_as(ma);
  select count(*) into n from public.ai_runs where snapshot_id = s1;
  assert n = 3, 'the requester sees their runs';
  select count(*) into n from public.ai_run_events where run_id = run1;
  assert n >= 6, 'the requester sees the run events';
  perform public.zz_as(owner1);
  select count(*) into n from public.ai_runs where snapshot_id = s1;
  assert n = 3, 'the owner sees runs in the organization';
  foreach fn in array array[mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    select count(*) into n from public.ai_runs where snapshot_id = s1;
    assert n = 0, 'runs hidden from ' || fn;
    select count(*) into n from public.ai_run_events where run_id = run1;
    assert n = 0, 'events hidden from ' || fn;
  end loop;

  ---------------------------------------------------------------- direct writes
  perform public.zz_as(ma);
  st := null;
  begin update public.ai_runs set status = 'completed' where id = run2; exception when others then st := sqlstate; end;
  assert st = '42501', 'direct UPDATE denied';

  ---------------------------------------------------------------- organization switch
  perform public.zz_as(ma);
  st := null;
  begin perform public.set_ai_enabled(org1, false); exception when others then st := sqlstate; end;
  assert st = '42501', 'a member cannot turn AI off';
  perform public.zz_as(admin1);
  perform public.set_ai_enabled(org1, false);
  perform public.zz_as(ma);
  st := null;
  begin perform public.start_ai_run(s1, 'code_qa', '{"question":"x"}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '55000', 'no runs while AI is off';
  reset role;
  select count(*) into n from public.organization_audit_events where organization_id = org1 and action = 'settings.ai_enabled';
  assert n = 1, 'turning AI off is audited';
  set local role authenticated;
  perform public.zz_as(owner1);
  perform public.set_ai_enabled(org1, true);

  ---------------------------------------------------------------- daily quota and stale sweep
  reset role;
  insert into public.ai_runs (organization_id, project_id, snapshot_id, requested_by, job_type, status, input, correlation_id, created_at, updated_at)
    select org1, p1, s1, owner1, 'code_qa', 'completed', '{}'::jsonb, gen_random_uuid(), now() - interval '1 hour', now() - interval '1 hour'
    from generate_series(1, 50);
  insert into public.ai_runs (organization_id, project_id, snapshot_id, requested_by, job_type, status, input, correlation_id, created_at, updated_at)
    values (org1, p1, s1, admin1, 'code_qa', 'generating', '{}'::jsonb, gen_random_uuid(), now() - interval '20 minutes', now() - interval '20 minutes');
  set local role authenticated;
  perform public.zz_as(owner1);
  st := null;
  begin perform public.start_ai_run(s1, 'code_qa', '{"question":"x"}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '54000', 'at most 50 runs per user per day';
  perform public.zz_as(admin1);
  perform public.start_ai_run(s1, 'code_qa', '{"question":"x"}'::jsonb);
  select count(*) into n from public.ai_runs where requested_by = admin1 and status = 'timed_out';
  assert n = 1, 'a run stuck for over 10 minutes is swept to timed_out';

  raise notice 'ai_runs_rls: all checks passed';
end;
$$;

rollback;
