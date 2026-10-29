-- Bug intelligence: AI whole-project bug scans, the bugs they find, and the audit trail of every change to a bug.
--
-- Bugs are derived from code, so they are written only by SECURITY DEFINER functions (never directly by clients):
--   start_bug_scan / record_bug_scan_batch / finish_bug_scan    OWNER/ADMIN of the snapshot's organization
-- Reads follow project visibility (can_see_project), like requirements and tasks: organization owners and admins see
-- every project; employees see the projects of their teams. Assignment and the fix workflow are in the next migration.

-- 1. Tables -------------------------------------------------------------------------------------------------------
create table public.repository_bug_scans (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  project_id        uuid not null references public.projects (id) on delete cascade,
  snapshot_id       uuid not null references public.repository_snapshots (id) on delete cascade,
  status            text not null default 'RUNNING' check (status in ('RUNNING', 'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED')),
  plan              jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 262144),
  batches_total     integer not null check (batches_total between 0 and 200),
  completed_batches integer[] not null default '{}',
  failed_batches    integer[] not null default '{}',
  files_total       integer not null check (files_total >= 0),
  files_planned     integer not null check (files_planned >= 0),
  bugs_found        integer not null default 0,
  bugs_new          integer not null default 0,
  input_tokens      bigint not null default 0,
  output_tokens     bigint not null default 0,
  cost_usd          numeric(12, 6) not null default 0,
  error_message     text check (char_length(error_message) <= 500),
  started_by        uuid references auth.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz
);
create index repository_bug_scans_snapshot_idx on public.repository_bug_scans (snapshot_id, created_at desc);
create index repository_bug_scans_project_idx on public.repository_bug_scans (project_id, created_at desc);
-- At most one running scan per snapshot, so two admins cannot start duplicate work.
create unique index repository_bug_scans_one_running on public.repository_bug_scans (snapshot_id) where status = 'RUNNING';

create table public.repository_bugs (
  id                uuid primary key default gen_random_uuid(),
  organization_id   uuid not null references public.organizations (id) on delete cascade,
  project_id        uuid not null references public.projects (id) on delete cascade,
  snapshot_id       uuid not null references public.repository_snapshots (id) on delete cascade, -- latest snapshot it was seen in
  first_scan_id     uuid references public.repository_bug_scans (id) on delete set null,
  last_scan_id      uuid references public.repository_bug_scans (id) on delete set null,
  file_id           uuid references public.repository_files (id) on delete set null,
  file_path         text not null check (char_length(file_path) between 1 and 1024),
  start_line        integer not null check (start_line >= 1),
  end_line          integer not null check (end_line >= start_line),
  title             text not null check (char_length(title) between 1 and 200),
  description       text not null check (char_length(description) between 1 and 2000),
  category          text not null check (category in ('frontend', 'backend', 'api', 'database', 'auth_security', 'repo_processing',
                                                       'llm_orchestration', 'token_usage', 'testing', 'configuration', 'performance', 'other')),
  severity          text not null check (severity in ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO')),
  severity_reason   text not null check (char_length(severity_reason) between 1 and 600),
  confidence        numeric(3, 2) not null check (confidence between 0 and 1),
  evidence          text not null check (char_length(evidence) between 1 and 1000),
  suggested_fix     text not null default '' check (char_length(suggested_fix) <= 2000),
  validation_steps  text not null default '' check (char_length(validation_steps) <= 1000),
  status            text not null default 'DETECTED' check (status in ('DETECTED', 'TRIAGED', 'ASSIGNED', 'IN_PROGRESS', 'FIX_PROPOSED',
                      'AWAITING_APPROVAL', 'FIX_APPLIED', 'TESTING', 'CODE_REVIEW', 'QA_VERIFICATION', 'RESOLVED', 'REJECTED', 'BLOCKED',
                      'REOPENED', 'CANCELLED')),
  assigned_to       uuid references auth.users (id) on delete set null,
  assigned_by       uuid references auth.users (id) on delete set null,
  assigned_at       timestamptz,
  assignment_source text check (assignment_source in ('MANUAL', 'AUTO')),
  assignment_reason text check (char_length(assignment_reason) <= 1000),
  fingerprint       text not null check (fingerprint ~ '^[0-9a-f]{40}$'),
  times_seen        integer not null default 1,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint repository_bugs_project_fingerprint_key unique (project_id, fingerprint)
);
create index repository_bugs_project_idx on public.repository_bugs (project_id, status, severity);
create index repository_bugs_assignee_idx on public.repository_bugs (assigned_to) where assigned_to is not null;
create index repository_bugs_snapshot_idx on public.repository_bugs (snapshot_id);
create trigger repository_bugs_set_updated_at before update on public.repository_bugs for each row execute function public.set_updated_at();

create table public.repository_bug_events (
  id          bigint generated always as identity primary key,
  bug_id      uuid not null references public.repository_bugs (id) on delete cascade,
  actor_id    uuid references auth.users (id) on delete set null,
  type        text not null check (type ~ '^[a-z_]+$' and char_length(type) <= 40),
  from_status text,
  to_status   text,
  details     jsonb not null default '{}'::jsonb check (octet_length(details::text) <= 4096),
  created_at  timestamptz not null default now()
);
create index repository_bug_events_bug_idx on public.repository_bug_events (bug_id, id);

-- 2. RLS: read-only for clients, visibility follows the project --------------------------------------------------------
alter table public.repository_bug_scans enable row level security;
alter table public.repository_bugs enable row level security;
alter table public.repository_bug_events enable row level security;

create policy "repository_bug_scans_select_project_visible" on public.repository_bug_scans for select to authenticated
  using (public.can_see_project(project_id));
create policy "repository_bugs_select_project_visible" on public.repository_bugs for select to authenticated
  using (public.can_see_project(project_id));
create policy "repository_bug_events_select_bug_visible" on public.repository_bug_events for select to authenticated
  using (exists (select 1 from public.repository_bugs b where b.id = repository_bug_events.bug_id));

revoke all on public.repository_bug_scans, public.repository_bugs, public.repository_bug_events from anon, authenticated;
grant select on public.repository_bug_scans, public.repository_bugs, public.repository_bug_events to authenticated;

-- 3. The status machine (mirrored by src/lib/bugs/model.ts; model.test.ts keeps them identical) --------------------------
create or replace function private.bug_transition_ok(p_from text, p_to text)
returns boolean language sql immutable set search_path = '' as $$
  select exists (
    select 1 from (values
      -- BEGIN bug transitions
      ('DETECTED', 'TRIAGED'), ('DETECTED', 'ASSIGNED'), ('DETECTED', 'REJECTED'), ('DETECTED', 'CANCELLED'),
      ('TRIAGED', 'ASSIGNED'), ('TRIAGED', 'REJECTED'), ('TRIAGED', 'CANCELLED'),
      ('ASSIGNED', 'IN_PROGRESS'), ('ASSIGNED', 'TRIAGED'), ('ASSIGNED', 'BLOCKED'), ('ASSIGNED', 'REJECTED'), ('ASSIGNED', 'CANCELLED'),
      ('IN_PROGRESS', 'FIX_PROPOSED'), ('IN_PROGRESS', 'ASSIGNED'), ('IN_PROGRESS', 'BLOCKED'),
      ('FIX_PROPOSED', 'AWAITING_APPROVAL'), ('FIX_PROPOSED', 'IN_PROGRESS'),
      ('AWAITING_APPROVAL', 'FIX_APPLIED'), ('AWAITING_APPROVAL', 'IN_PROGRESS'),
      ('FIX_APPLIED', 'TESTING'), ('FIX_APPLIED', 'IN_PROGRESS'),
      ('TESTING', 'CODE_REVIEW'), ('TESTING', 'IN_PROGRESS'),
      ('CODE_REVIEW', 'QA_VERIFICATION'), ('CODE_REVIEW', 'IN_PROGRESS'),
      ('QA_VERIFICATION', 'RESOLVED'), ('QA_VERIFICATION', 'IN_PROGRESS'),
      ('RESOLVED', 'REOPENED'), ('REJECTED', 'REOPENED'),
      ('BLOCKED', 'ASSIGNED'), ('BLOCKED', 'IN_PROGRESS'), ('BLOCKED', 'CANCELLED'),
      ('REOPENED', 'TRIAGED'), ('REOPENED', 'ASSIGNED'), ('REOPENED', 'IN_PROGRESS'),
      ('CANCELLED', 'REOPENED')
      -- END bug transitions
    ) as t(f, t) where t.f = p_from and t.t = p_to
  );
$$;
revoke all on function private.bug_transition_ok(text, text) from public, anon, authenticated;

-- 4. AI jobs: bug_scan (one run per batch of files) and bug_fix_plan -------------------------------------------------------
alter table public.ai_runs drop constraint if exists ai_runs_job_type_check;
alter table public.ai_runs add constraint ai_runs_job_type_check
  check (job_type in ('code_qa', 'requirement_trace', 'code_review', 'generate', 'bug_scan', 'bug_fix_plan'));

-- Same function as before with the two new job types. Scan batches would exhaust the interactive daily limit of 50 in
-- one scan, so bug jobs have their own limit (300 per 24 hours) and no longer count against the interactive one.
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
  v_bug_job boolean;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_job_type is null or p_job_type not in ('code_qa', 'requirement_trace', 'code_review', 'generate', 'bug_scan', 'bug_fix_plan') then
    raise exception 'Unknown AI job' using errcode = '22023';
  end if;
  v_bug_job := p_job_type in ('bug_scan', 'bug_fix_plan');
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

  update public.ai_runs a
  set status = 'timed_out', error_category = 'deadline', error_message = 'The run stopped responding.', updated_at = now(), completed_at = now()
  where a.requested_by = v_user and a.status not in ('completed', 'failed', 'cancelled', 'timed_out')
    and a.updated_at < now() - interval '10 minutes';

  perform pg_advisory_xact_lock(hashtextextended('ai_runs:' || v_user::text, 0));
  if (select count(*) from public.ai_runs a
      where a.requested_by = v_user and a.status not in ('completed', 'failed', 'cancelled', 'timed_out')) >= 2 then
    raise exception 'Too many AI runs in progress. Wait for one to finish.' using errcode = '54000';
  end if;
  if v_bug_job then
    if (select count(*) from public.ai_runs a where a.requested_by = v_user and a.created_at > now() - interval '24 hours'
          and a.job_type in ('bug_scan', 'bug_fix_plan')) >= 300 then
      raise exception 'Daily bug-analysis limit reached (300 AI runs per 24 hours).' using errcode = '54000';
    end if;
  elsif (select count(*) from public.ai_runs a where a.requested_by = v_user and a.created_at > now() - interval '24 hours'
           and a.job_type not in ('bug_scan', 'bug_fix_plan')) >= 50 then
    raise exception 'Daily AI run limit reached (50 per 24 hours).' using errcode = '54000';
  end if;

  insert into public.ai_runs (organization_id, project_id, snapshot_id, requested_by, job_type, input)
  values (v_org, v_project, p_snapshot_id, v_user, p_job_type, p_input)
  returning id, correlation_id into v_run, v_correlation;
  insert into public.ai_run_events (run_id, state) values (v_run, 'queued');
  return query select v_run, v_correlation;
end;
$$;

-- 5. Scan functions ------------------------------------------------------------------------------------------------------
create or replace function public.start_bug_scan(p_snapshot_id uuid, p_plan jsonb, p_files_total integer, p_files_planned integer)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_status text;
  v_project uuid;
  v_org uuid;
  v_batches integer;
  v_id uuid;
begin
  perform private.require_snapshot_admin(p_snapshot_id);
  select s.status, p.id, d.organization_id into v_status, v_project, v_org
  from public.repository_snapshots s
  join public.repositories r on r.id = s.repository_id
  join public.projects p on p.id = r.project_id
  join public.teams t on t.id = p.team_id
  join public.departments d on d.id = t.department_id
  where s.id = p_snapshot_id;
  if v_status is distinct from 'COMPLETED' then raise exception 'Only a completed import can be scanned' using errcode = '55000'; end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' or jsonb_typeof(p_plan -> 'batches') <> 'array' then
    raise exception 'Invalid scan plan' using errcode = '22023';
  end if;
  v_batches := jsonb_array_length(p_plan -> 'batches');
  -- A scan that stopped responding (server restart, closed tab) is closed so a new one can start.
  update public.repository_bug_scans x set status = 'PARTIAL', completed_at = now(), updated_at = now(),
    error_message = 'The scan stopped responding.'
  where x.snapshot_id = p_snapshot_id and x.status = 'RUNNING' and x.updated_at < now() - interval '15 minutes';
  begin
    insert into public.repository_bug_scans (organization_id, project_id, snapshot_id, plan, batches_total, files_total, files_planned, started_by, status, completed_at)
    values (v_org, v_project, p_snapshot_id, p_plan, v_batches, p_files_total, p_files_planned, (select auth.uid()),
            case when v_batches = 0 then 'COMPLETED' else 'RUNNING' end, case when v_batches = 0 then now() end)
    returning id into v_id;
  exception when unique_violation then
    raise exception 'A scan of this snapshot is already running' using errcode = '55000';
  end;
  perform private.record_audit(v_org, 'bugs.scan_started', null, null, jsonb_build_object('scan_id', v_id, 'snapshot_id', p_snapshot_id, 'batches', v_batches));
  return v_id;
end;
$$;

-- Stores one batch's verified findings and advances the scan. Idempotent per batch index (a retried request cannot
-- count twice). Findings are de-duplicated per project by fingerprint: a bug seen again updates its location and counter;
-- a resolved bug that comes back is reopened.
create or replace function public.record_bug_scan_batch(
  p_scan_id uuid, p_batch_index integer, p_findings jsonb, p_failed boolean,
  p_input_tokens bigint, p_output_tokens bigint, p_cost_usd numeric, p_error text
)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_scan public.repository_bug_scans;
  f jsonb;
  v_file uuid;
  v_bug public.repository_bugs;
  v_new integer := 0;
  v_seen integer := 0;
  v_skipped integer := 0;
  v_done integer;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_scan from public.repository_bug_scans x where x.id = p_scan_id for update;
  if v_scan.id is null or coalesce(private.caller_org_role(v_scan.organization_id), '') not in ('OWNER', 'ADMIN') then
    raise exception 'Scan not found' using errcode = '42501';
  end if;
  if v_scan.status <> 'RUNNING' then raise exception 'The scan is not running' using errcode = '55000'; end if;
  if p_batch_index is null or p_batch_index < 0 or p_batch_index >= v_scan.batches_total then raise exception 'Invalid batch' using errcode = '22023'; end if;
  if p_batch_index = any (v_scan.completed_batches) or p_batch_index = any (v_scan.failed_batches) then
    return jsonb_build_object('duplicate', true);
  end if;
  if p_findings is null or jsonb_typeof(p_findings) <> 'array' or jsonb_array_length(p_findings) > 40 then raise exception 'Invalid findings' using errcode = '22023'; end if;

  if not coalesce(p_failed, false) then
    for f in select e from jsonb_array_elements(p_findings) as e loop
      select rf.id into v_file from public.repository_files rf where rf.snapshot_id = v_scan.snapshot_id and rf.path = f ->> 'path';
      if v_file is null then v_skipped := v_skipped + 1; continue; end if;
      select * into v_bug from public.repository_bugs b where b.project_id = v_scan.project_id and b.fingerprint = f ->> 'fingerprint' for update;
      if v_bug.id is null then
        insert into public.repository_bugs (organization_id, project_id, snapshot_id, first_scan_id, last_scan_id, file_id, file_path, start_line, end_line,
          title, description, category, severity, severity_reason, confidence, evidence, suggested_fix, validation_steps, fingerprint)
        values (v_scan.organization_id, v_scan.project_id, v_scan.snapshot_id, v_scan.id, v_scan.id, v_file, f ->> 'path',
          (f ->> 'start_line')::int, (f ->> 'end_line')::int, f ->> 'title', f ->> 'description', f ->> 'category', f ->> 'severity',
          f ->> 'severity_reason', (f ->> 'confidence')::numeric, f ->> 'evidence', coalesce(f ->> 'suggested_fix', ''), coalesce(f ->> 'validation_steps', ''),
          f ->> 'fingerprint')
        returning * into v_bug;
        insert into public.repository_bug_events (bug_id, actor_id, type, to_status, details)
        values (v_bug.id, (select auth.uid()), 'detected', 'DETECTED', jsonb_build_object('scan_id', v_scan.id, 'confidence', v_bug.confidence));
        v_new := v_new + 1;
      else
        update public.repository_bugs b set snapshot_id = v_scan.snapshot_id, last_scan_id = v_scan.id, file_id = v_file,
          start_line = (f ->> 'start_line')::int, end_line = (f ->> 'end_line')::int, times_seen = b.times_seen + 1
        where b.id = v_bug.id;
        insert into public.repository_bug_events (bug_id, actor_id, type, details)
        values (v_bug.id, (select auth.uid()), 'rescanned', jsonb_build_object('scan_id', v_scan.id));
        if v_bug.status = 'RESOLVED' then
          update public.repository_bugs b set status = 'REOPENED', assigned_to = null, assigned_at = null, assignment_source = null where b.id = v_bug.id;
          insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
          values (v_bug.id, (select auth.uid()), 'reopened_by_scan', 'RESOLVED', 'REOPENED', jsonb_build_object('scan_id', v_scan.id));
        end if;
        v_seen := v_seen + 1;
      end if;
    end loop;
  end if;

  update public.repository_bug_scans x set
    completed_batches = case when coalesce(p_failed, false) then x.completed_batches else x.completed_batches || p_batch_index end,
    failed_batches = case when coalesce(p_failed, false) then x.failed_batches || p_batch_index else x.failed_batches end,
    bugs_found = x.bugs_found + v_new + v_seen,
    bugs_new = x.bugs_new + v_new,
    input_tokens = x.input_tokens + greatest(coalesce(p_input_tokens, 0), 0),
    output_tokens = x.output_tokens + greatest(coalesce(p_output_tokens, 0), 0),
    cost_usd = x.cost_usd + greatest(coalesce(p_cost_usd, 0), 0),
    error_message = coalesce(left(p_error, 500), x.error_message),
    updated_at = now()
  where x.id = v_scan.id;

  select coalesce(cardinality(x.completed_batches), 0) + coalesce(cardinality(x.failed_batches), 0) into v_done from public.repository_bug_scans x where x.id = v_scan.id;
  if v_done >= v_scan.batches_total then
    update public.repository_bug_scans x set completed_at = now(),
      status = case when cardinality(x.failed_batches) = 0 then 'COMPLETED' when cardinality(x.completed_batches) = 0 then 'FAILED' else 'PARTIAL' end
    where x.id = v_scan.id;
  end if;
  return jsonb_build_object('new', v_new, 'seen_again', v_seen, 'skipped', v_skipped, 'batches_done', v_done);
end;
$$;

create or replace function public.finish_bug_scan(p_scan_id uuid, p_status text, p_error text)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_scan public.repository_bug_scans;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if p_status not in ('FAILED', 'CANCELLED') then raise exception 'Invalid status' using errcode = '22023'; end if;
  select * into v_scan from public.repository_bug_scans x where x.id = p_scan_id for update;
  if v_scan.id is null or coalesce(private.caller_org_role(v_scan.organization_id), '') not in ('OWNER', 'ADMIN') then raise exception 'Scan not found' using errcode = '42501'; end if;
  if v_scan.status <> 'RUNNING' then return; end if;
  update public.repository_bug_scans x set status = case when cardinality(x.completed_batches) > 0 and p_status = 'FAILED' then 'PARTIAL' else p_status end,
    error_message = left(p_error, 500), completed_at = now(), updated_at = now() where x.id = p_scan_id;
end;
$$;

-- Continues a scan that stopped (failed batches, cancelled, or a closed tab): failed batches are tried again, finished
-- ones are never repeated.
create or replace function public.resume_bug_scan(p_scan_id uuid)
returns void
language plpgsql security definer set search_path = '' as $$
declare v_scan public.repository_bug_scans;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_scan from public.repository_bug_scans x where x.id = p_scan_id for update;
  if v_scan.id is null or coalesce(private.caller_org_role(v_scan.organization_id), '') not in ('OWNER', 'ADMIN') then raise exception 'Scan not found' using errcode = '42501'; end if;
  if v_scan.status = 'RUNNING' then return; end if;
  if v_scan.status = 'COMPLETED' or cardinality(v_scan.completed_batches) >= v_scan.batches_total then raise exception 'Nothing left to scan' using errcode = '55000'; end if;
  begin
    update public.repository_bug_scans x set status = 'RUNNING', failed_batches = '{}', completed_at = null, error_message = null, updated_at = now() where x.id = p_scan_id;
  exception when unique_violation then
    raise exception 'A scan of this snapshot is already running' using errcode = '55000';
  end;
end;
$$;

revoke all on function public.start_ai_run(uuid, text, jsonb) from public, anon;
revoke all on function public.start_bug_scan(uuid, jsonb, integer, integer) from public, anon;
revoke all on function public.record_bug_scan_batch(uuid, integer, jsonb, boolean, bigint, bigint, numeric, text) from public, anon;
revoke all on function public.finish_bug_scan(uuid, text, text) from public, anon;
revoke all on function public.resume_bug_scan(uuid) from public, anon;
grant execute on function public.start_ai_run(uuid, text, jsonb) to authenticated;
grant execute on function public.start_bug_scan(uuid, jsonb, integer, integer) to authenticated;
grant execute on function public.record_bug_scan_batch(uuid, integer, jsonb, boolean, bigint, bigint, numeric, text) to authenticated;
grant execute on function public.finish_bug_scan(uuid, text, text) to authenticated;
grant execute on function public.resume_bug_scan(uuid) to authenticated;
