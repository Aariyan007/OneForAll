-- AI assistant runs: one row per request to an AI job (code Q&A, requirement trace, review / bug explain, tests / docs
-- generation), its lifecycle events, and a per-organization switch.
--
-- Rules:
--   * Only someone who can see the project may start a run on one of its COMPLETED snapshots, and only while the
--     organization has AI turned on (organization_settings.ai_enabled, default on; OWNER/ADMIN toggle, audited).
--   * Quotas per user: at most 2 active runs and 50 runs per rolling 24 hours.
--   * The lifecycle mirrors src/server/ai/state.ts; every transition is validated here too. Only the requester (the
--     server acting for them) records progress and the outcome. A run stuck in an active state for 10 minutes is
--     swept to timed_out when the same user starts another run.
--   * Reads: the requester (while they can still see the project) and OWNER/ADMIN of the organization. Rows hold the
--     request, the validated answer and usage metrics; never prompts, provider responses, code excerpts or keys.
--   * The outcome is recorded by the server for the requester; a requester calling the functions directly can only
--     ever write their own run, which only they and organization admins can see.

alter table public.organization_settings add column ai_enabled boolean not null default true;

create table public.ai_runs (
  id                      uuid primary key default gen_random_uuid(),
  organization_id         uuid not null references public.organizations (id) on delete cascade,
  project_id              uuid not null references public.projects (id) on delete cascade,
  snapshot_id             uuid not null references public.repository_snapshots (id) on delete cascade,
  requested_by            uuid not null references auth.users (id) on delete cascade,
  job_type                text not null check (job_type in ('code_qa', 'requirement_trace', 'code_review', 'generate')),
  status                  text not null default 'queued' check (status in
                            ('queued', 'validating', 'retrieving_context', 'generating', 'executing_tool', 'validating_output',
                             'completed', 'failed', 'cancelled', 'timed_out')),
  input                   jsonb not null check (octet_length(input::text) <= 16384),
  output                  jsonb check (output is null or octet_length(output::text) <= 262144),
  error_category          text check (error_category is null or error_category ~ '^[a-z_]{2,40}$'),
  error_message           text check (error_message is null or char_length(error_message) <= 500),
  tier                    text check (tier is null or tier in ('fast', 'standard', 'deep')),
  model                   text check (model is null or char_length(model) <= 100),
  input_tokens            integer not null default 0 check (input_tokens >= 0),
  output_tokens           integer not null default 0 check (output_tokens >= 0),
  cached_input_tokens     integer not null default 0 check (cached_input_tokens >= 0),
  thinking_tokens         integer not null default 0 check (thinking_tokens >= 0),
  estimated_cost_usd      numeric(12, 6) not null default 0 check (estimated_cost_usd >= 0),
  model_calls             integer not null default 0 check (model_calls >= 0),
  tool_calls              integer not null default 0 check (tool_calls >= 0),
  attempts                integer not null default 0 check (attempts >= 0),
  fallback_used           boolean not null default false,
  citations_dropped       integer not null default 0 check (citations_dropped >= 0),
  context_tokens_estimate integer not null default 0 check (context_tokens_estimate >= 0),
  correlation_id          uuid not null unique default gen_random_uuid(),
  cancel_requested        boolean not null default false,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  completed_at            timestamptz
);

create index ai_runs_requested_by_created_idx on public.ai_runs (requested_by, created_at desc);
create index ai_runs_project_created_idx on public.ai_runs (project_id, created_at desc);
create index ai_runs_active_idx on public.ai_runs (requested_by)
  where status not in ('completed', 'failed', 'cancelled', 'timed_out');

create table public.ai_run_events (
  id         bigint generated always as identity primary key,
  run_id     uuid not null references public.ai_runs (id) on delete cascade,
  state      text not null,
  detail     jsonb check (detail is null or octet_length(detail::text) <= 2048),
  created_at timestamptz not null default now()
);

create index ai_run_events_run_idx on public.ai_run_events (run_id, id);

alter table public.ai_runs enable row level security;
alter table public.ai_run_events enable row level security;

-- Whether the CALLER can see a project (the full rule, suspension included). A public wrapper because RLS policies
-- run as the client role, which may not execute private helpers; it answers only for the caller's own id.
create or replace function public.can_see_project(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.user_can_see_project((select auth.uid()), p_project_id);
$$;
revoke all on function public.can_see_project(uuid) from public, anon;
grant execute on function public.can_see_project(uuid) to authenticated;

create policy "ai_runs_select_requester_or_admin" on public.ai_runs for select to authenticated
  using (
    (requested_by = (select auth.uid()) and public.can_see_project(project_id))
    or public.has_org_role(organization_id, array['OWNER', 'ADMIN'])
  );

create policy "ai_run_events_select_run_visible" on public.ai_run_events for select to authenticated
  using (exists (select 1 from public.ai_runs r where r.id = ai_run_events.run_id));

revoke all on public.ai_runs, public.ai_run_events from anon, authenticated;
grant select on public.ai_runs, public.ai_run_events to authenticated;

-- Same table as src/server/ai/state.ts.
create or replace function private.ai_transition_ok(p_from text, p_to text)
returns boolean language sql immutable set search_path = '' as $$
  select case p_from
    when 'queued'             then p_to in ('validating', 'failed', 'cancelled')
    when 'validating'         then p_to in ('retrieving_context', 'failed', 'cancelled')
    when 'retrieving_context' then p_to in ('generating', 'failed', 'cancelled', 'timed_out')
    when 'generating'         then p_to in ('executing_tool', 'validating_output', 'failed', 'cancelled', 'timed_out')
    when 'executing_tool'     then p_to in ('generating', 'failed', 'cancelled', 'timed_out')
    when 'validating_output'  then p_to in ('completed', 'generating', 'failed', 'cancelled', 'timed_out')
    else false
  end;
$$;

create or replace function public.start_ai_run(p_snapshot_id uuid, p_job_type text, p_input jsonb)
returns table (run_id uuid, correlation_id uuid)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_user uuid := (select auth.uid());
  v_status text;
  v_project uuid;
  v_org uuid;
  v_run uuid;
  v_correlation uuid;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_job_type is null or p_job_type not in ('code_qa', 'requirement_trace', 'code_review', 'generate') then
    raise exception 'Unknown AI job' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' or octet_length(p_input::text) > 16384 then
    raise exception 'Invalid AI request' using errcode = '22023';
  end if;

  select s.status, p.id, d.organization_id into v_status, v_project, v_org
  from public.repository_snapshots s
  join public.repositories r on r.id = s.repository_id
  join public.projects p on p.id = r.project_id
  join public.teams t on t.id = p.team_id
  join public.departments d on d.id = t.department_id
  where s.id = p_snapshot_id;
  if v_project is null or not private.user_can_see_project(v_user, v_project) then
    raise exception 'Snapshot not found' using errcode = '42501';
  end if;
  if v_status <> 'COMPLETED' then
    raise exception 'The AI assistant works on completed snapshots only' using errcode = '55000';
  end if;
  if not coalesce((select os.ai_enabled from public.organization_settings os where os.organization_id = v_org), true) then
    raise exception 'The AI assistant is turned off for this organization' using errcode = '55000';
  end if;

  -- Close this user's runs that a crashed or disconnected request left active.
  update public.ai_runs a
  set status = 'timed_out', error_category = 'deadline', error_message = 'The run stopped responding.', updated_at = now(), completed_at = now()
  where a.requested_by = v_user and a.status not in ('completed', 'failed', 'cancelled', 'timed_out')
    and a.updated_at < now() - interval '10 minutes';

  perform pg_advisory_xact_lock(hashtextextended('ai_runs:' || v_user::text, 0));
  if (select count(*) from public.ai_runs a
      where a.requested_by = v_user and a.status not in ('completed', 'failed', 'cancelled', 'timed_out')) >= 2 then
    raise exception 'Too many AI runs in progress. Wait for one to finish.' using errcode = '54000';
  end if;
  if (select count(*) from public.ai_runs a where a.requested_by = v_user and a.created_at > now() - interval '24 hours') >= 50 then
    raise exception 'Daily AI run limit reached (50 per 24 hours).' using errcode = '54000';
  end if;

  insert into public.ai_runs (organization_id, project_id, snapshot_id, requested_by, job_type, input)
  values (v_org, v_project, p_snapshot_id, v_user, p_job_type, p_input)
  returning id, correlation_id into v_run, v_correlation;
  insert into public.ai_run_events (run_id, state) values (v_run, 'queued');
  return query select v_run, v_correlation;
end;
$$;

-- Locks the caller's own run and returns its current status (42501 for anyone else's, or an unknown id).
create or replace function private.lock_own_ai_run(p_run_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select a.status into v_status from public.ai_runs a where a.id = p_run_id and a.requested_by = (select auth.uid()) for update;
  if v_status is null then raise exception 'Run not found' using errcode = '42501'; end if;
  return v_status;
end;
$$;

create or replace function public.record_ai_run_state(p_run_id uuid, p_state text, p_detail jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status text;
begin
  v_status := private.lock_own_ai_run(p_run_id);
  if p_state in ('completed', 'failed', 'cancelled', 'timed_out') then
    raise exception 'Terminal states are recorded with finish_ai_run' using errcode = '22023';
  end if;
  if p_detail is not null and (jsonb_typeof(p_detail) <> 'object' or octet_length(p_detail::text) > 2048) then
    raise exception 'Invalid detail' using errcode = '22023';
  end if;
  if not private.ai_transition_ok(v_status, p_state) then
    raise exception 'Invalid AI run transition % -> %', v_status, p_state using errcode = '55000';
  end if;
  update public.ai_runs a set status = p_state, updated_at = now() where a.id = p_run_id;
  insert into public.ai_run_events (run_id, state, detail) values (p_run_id, p_state, p_detail);
end;
$$;

create or replace function public.finish_ai_run(
  p_run_id uuid, p_status text, p_output jsonb, p_error_category text, p_error_message text, p_metrics jsonb
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  m jsonb := coalesce(p_metrics, '{}'::jsonb);
begin
  v_status := private.lock_own_ai_run(p_run_id);
  if p_status not in ('completed', 'failed', 'cancelled', 'timed_out') then
    raise exception 'finish_ai_run records terminal states only' using errcode = '22023';
  end if;
  if p_error_category is not null and p_error_category !~ '^[a-z_]{2,40}$' then
    raise exception 'Invalid error category' using errcode = '22023';
  end if;
  if jsonb_typeof(m) <> 'object' then raise exception 'Invalid metrics' using errcode = '22023'; end if;
  if (p_status = 'completed') <> (p_output is not null) then
    raise exception 'A completed run needs an output, and only a completed run has one' using errcode = '22023';
  end if;
  -- A run may end as failed or cancelled from any active state (failures before a model call included).
  if not (private.ai_transition_ok(v_status, p_status)
          or (p_status in ('failed', 'cancelled') and v_status not in ('completed', 'failed', 'cancelled', 'timed_out'))) then
    raise exception 'Invalid AI run transition % -> %', v_status, p_status using errcode = '55000';
  end if;

  update public.ai_runs a set
    status = p_status,
    output = p_output,
    error_category = p_error_category,
    error_message = left(p_error_message, 500),
    tier = coalesce(m ->> 'tier', a.tier),
    model = left(coalesce(m ->> 'model', a.model), 100),
    input_tokens = greatest(0, coalesce((m ->> 'input_tokens')::int, 0)),
    output_tokens = greatest(0, coalesce((m ->> 'output_tokens')::int, 0)),
    cached_input_tokens = greatest(0, coalesce((m ->> 'cached_input_tokens')::int, 0)),
    thinking_tokens = greatest(0, coalesce((m ->> 'thinking_tokens')::int, 0)),
    estimated_cost_usd = greatest(0, coalesce((m ->> 'estimated_cost_usd')::numeric, 0)),
    model_calls = greatest(0, coalesce((m ->> 'model_calls')::int, 0)),
    tool_calls = greatest(0, coalesce((m ->> 'tool_calls')::int, 0)),
    attempts = greatest(0, coalesce((m ->> 'attempts')::int, 0)),
    fallback_used = coalesce((m ->> 'fallback_used')::boolean, false),
    citations_dropped = greatest(0, coalesce((m ->> 'citations_dropped')::int, 0)),
    context_tokens_estimate = greatest(0, coalesce((m ->> 'context_tokens_estimate')::int, 0)),
    updated_at = now(),
    completed_at = now()
  where a.id = p_run_id;
  insert into public.ai_run_events (run_id, state, detail)
  values (p_run_id, p_status, case when p_error_category is null then null else jsonb_build_object('category', p_error_category) end);
end;
$$;

create or replace function public.request_ai_run_cancel(p_run_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_run record;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select a.requested_by, a.organization_id, a.status into v_run from public.ai_runs a where a.id = p_run_id for update;
  if v_run is null or not (v_run.requested_by = (select auth.uid()) or public.has_org_role(v_run.organization_id, array['OWNER', 'ADMIN'])) then
    raise exception 'Run not found' using errcode = '42501';
  end if;
  if v_run.status in ('completed', 'failed', 'cancelled', 'timed_out') then return false; end if;
  update public.ai_runs a set cancel_requested = true, updated_at = now() where a.id = p_run_id;
  return true;
end;
$$;

create or replace function public.set_ai_enabled(p_organization_id uuid, p_enabled boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if not public.has_org_role(p_organization_id, array['OWNER', 'ADMIN']) then
    raise exception 'Only owners and admins can change the AI setting' using errcode = '42501';
  end if;
  if p_enabled is null then raise exception 'Invalid setting' using errcode = '22023'; end if;
  insert into public.organization_settings as s (organization_id, ai_enabled, updated_by, updated_at)
  values (p_organization_id, p_enabled, (select auth.uid()), now())
  on conflict (organization_id) do update set ai_enabled = excluded.ai_enabled, updated_by = excluded.updated_by, updated_at = now();
  perform private.record_audit(p_organization_id, 'settings.ai_enabled', null, null, jsonb_build_object('enabled', p_enabled));
end;
$$;

revoke all on function private.ai_transition_ok(text, text) from public, anon, authenticated;
revoke all on function private.lock_own_ai_run(uuid) from public, anon, authenticated;
revoke all on function public.start_ai_run(uuid, text, jsonb) from public, anon;
revoke all on function public.record_ai_run_state(uuid, text, jsonb) from public, anon;
revoke all on function public.finish_ai_run(uuid, text, jsonb, text, text, jsonb) from public, anon;
revoke all on function public.request_ai_run_cancel(uuid) from public, anon;
revoke all on function public.set_ai_enabled(uuid, boolean) from public, anon;
grant execute on function public.start_ai_run(uuid, text, jsonb) to authenticated;
grant execute on function public.record_ai_run_state(uuid, text, jsonb) to authenticated;
grant execute on function public.finish_ai_run(uuid, text, jsonb, text, text, jsonb) to authenticated;
grant execute on function public.request_ai_run_cancel(uuid) to authenticated;
grant execute on function public.set_ai_enabled(uuid, boolean) to authenticated;
