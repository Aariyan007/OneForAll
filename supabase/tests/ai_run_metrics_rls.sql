-- Per-run provider, usage and routing metrics (migration 20261030000001): finish_ai_run stores them, bad values are refused,
-- unreported usage stays distinguishable from zero, and RLS keeps every run visible only to its requester, org admins and no
-- other tenant. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/ai_run_metrics_rls.sql

set client_encoding = 'UTF8';
begin;

create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000b101';
  admin1 uuid := '00000000-0000-0000-0000-00000000b104';
  ma     uuid := '00000000-0000-0000-0000-00000000b102'; -- MEMBER of the project's team
  mb     uuid := '00000000-0000-0000-0000-00000000b103'; -- MEMBER of another team: cannot see the project
  owner2 uuid := '00000000-0000-0000-0000-00000000b201'; -- other tenant
  org1 uuid; org2 uuid; d1 uuid; ta uuid; tb uuid; p1 uuid; r1 uuid; s1 uuid;
  run_a uuid; run_b uuid; run_c uuid; run_d uuid; run_e uuid;
  r record; n int; st text;
begin
  insert into auth.users (id, email) values (owner1,'mo1@m.local'),(admin1,'ma1@m.local'),(ma,'mma@m.local'),(mb,'mmb@m.local'),(owner2,'mo2@m.local');
  insert into public.organizations (name,slug,created_by) values ('Metrics One','metrics-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Metrics Two','metrics-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role)
    values (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p1,'GITHUB','https://github.com/a/p','a','p','main',owner1) returning id into r1;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (r1,repeat('a',40),'main') returning id into s1;
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id = s1;
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id = s1;

  -- Clients still cannot write the table, new columns included.
  assert not has_column_privilege('authenticated', 'public.ai_runs', 'provider', 'update'), 'provider is not client-writable';
  assert not has_column_privilege('authenticated', 'public.ai_runs', 'usage_reported', 'update'), 'usage_reported is not client-writable';
  assert has_function_privilege('authenticated', 'public.finish_ai_run(uuid,text,jsonb,text,text,jsonb)', 'execute'), 'finish_ai_run keeps its grant';
  assert not has_function_privilege('anon', 'public.finish_ai_run(uuid,text,jsonb,text,text,jsonb)', 'execute'), 'and stays closed to anon';

  set local role authenticated;
  perform public.zz_as(ma);

  -- A run answered by Groq after a Gemini rate limit: provider, reported usage, known cost, baseline, route and techniques are kept.
  select run_id into run_a from public.start_ai_run(s1, 'code_qa', '{"question":"one"}'::jsonb);
  perform public.record_ai_run_state(run_a, 'validating', null);
  perform public.record_ai_run_state(run_a, 'retrieving_context', null);
  perform public.record_ai_run_state(run_a, 'generating', null);
  perform public.record_ai_run_state(run_a, 'validating_output', null);
  perform public.finish_ai_run(run_a, 'completed', '{"answer":"ok","citations":[]}'::jsonb, null, null, jsonb_build_object(
    'tier', 'fast', 'model', 'openai/gpt-oss-20b', 'provider', 'groq', 'input_tokens', 900, 'output_tokens', 60, 'thinking_tokens', 10,
    'estimated_cost_usd', 0.0001, 'model_calls', 1, 'attempts', 2, 'fallback_used', true, 'context_tokens_estimate', 700,
    'usage_reported', true, 'cost_known', true, 'baseline_tokens_estimate', 50000,
    'route', jsonb_build_object('category', 'simple_qa', 'reason', 'short question', 'attempts', jsonb_build_array(
      jsonb_build_object('provider', 'gemini', 'model', 'gemini-3.5-flash-lite', 'tier', 'fast', 'outcome', 'rate_limited', 'ms', 80, 'usageReported', false),
      jsonb_build_object('provider', 'groq', 'model', 'openai/gpt-oss-20b', 'tier', 'fast', 'outcome', 'ok', 'ms', 400, 'usageReported', true))),
    'techniques', jsonb_build_array('retrieval-based context selection', 'secret redaction')));
  select * into r from public.ai_runs where id = run_a;
  assert r.provider = 'groq' and r.usage_reported and r.cost_known and r.baseline_tokens_estimate = 50000 and r.fallback_used, 'new metrics are stored';
  assert r.route -> 'attempts' -> 0 ->> 'outcome' = 'rate_limited' and jsonb_array_length(r.route -> 'attempts') = 2, 'the routing trail is stored';
  assert jsonb_array_length(r.techniques) = 2, 'techniques are stored';

  -- A run that sent no new metric keys (the previous shape) reads as "not reported / not known / not measured", never as measured zeros.
  select run_id into run_b from public.start_ai_run(s1, 'code_qa', '{"question":"two"}'::jsonb);
  perform public.finish_ai_run(run_b, 'failed', null, 'not_configured', 'No provider is configured.', '{}'::jsonb);
  select * into r from public.ai_runs where id = run_b;
  assert r.provider is null and not r.usage_reported and not r.cost_known and r.baseline_tokens_estimate is null and r.route is null, 'a bare finish leaves the new metrics unset';

  -- Unknown providers and oversized routes are refused by the table, not trusted from the caller.
  select run_id into run_c from public.start_ai_run(s1, 'code_qa', '{"question":"three"}'::jsonb);
  st := null;
  begin perform public.finish_ai_run(run_c, 'failed', null, 'internal', 'x', '{"provider":"evilcorp"}'::jsonb); exception when others then st := sqlstate; end;
  assert st = '23514', 'an unknown provider is refused (got ' || coalesce(st, 'none') || ')';
  st := null;
  begin perform public.finish_ai_run(run_c, 'failed', null, 'internal', 'x', jsonb_build_object('route', jsonb_build_object('attempts', repeat('x', 5000)))); exception when others then st := sqlstate; end;
  assert st = '23514', 'an oversized routing trail is refused (got ' || coalesce(st, 'none') || ')';
  perform public.finish_ai_run(run_c, 'cancelled', null, 'cancelled', 'Cancelled.', '{"model_calls":0}'::jsonb);

  -- Scope: a member sees only their own runs; an admin of the organization sees them all; others see nothing.
  perform public.zz_as(admin1);
  select run_id into run_d from public.start_ai_run(s1, 'code_qa', '{"question":"admin"}'::jsonb);
  perform public.finish_ai_run(run_d, 'failed', null, 'timeout', 'The provider did not answer in time.', '{"provider":"openrouter","attempts":3}'::jsonb);

  perform public.zz_as(ma);
  select count(*) into n from public.ai_runs; assert n = 3, 'the member reads their own three runs only (got ' || n || ')';
  select count(*) into n from public.ai_runs where requested_by = ma and provider = 'groq' and usage_reported; assert n = 1, 'own query by provider';
  perform public.zz_as(admin1);
  select count(*) into n from public.ai_runs; assert n = 4, 'an organization admin reads every run of the organization (got ' || n || ')';
  select count(*) into n from public.ai_runs where requested_by = admin1; assert n = 1, 'a personal total filters on the requester';
  perform public.zz_as(mb);
  select count(*) into n from public.ai_runs; assert n = 0, 'a member who cannot see the project reads no runs (got ' || n || ')';
  perform public.zz_as(owner2);
  select count(*) into n from public.ai_runs; assert n = 0, 'another tenant reads no runs';
  perform public.zz_as(ma);
  st := null;
  begin update public.ai_runs set provider = 'groq' where id = run_b; exception when others then st := sqlstate; end;
  assert st = '42501', 'clients cannot update run metrics (got ' || coalesce(st, 'none') || ')';
end $$;
rollback;
select 'ai_run_metrics_rls: ok' as result;
