-- Approval-based fix workflow: the AI proposes a plan and a patch, a person approves it, the patch is applied to the
-- stored working copy (the imported snapshot is never modified), validated, and handed on to testing, code review and QA.
--
-- Rules enforced here, not in the UI:
--   * a fix is proposed only for a bug that is IN_PROGRESS, by its assignee or an admin, against the stored file content
--     (base_hash must equal the snapshot file's hash; patched_hash is recomputed here);
--   * only a person (the assignee or an admin) approves; nothing is applied without an APPROVED decision;
--   * "applied" needs a recorded validation that passed; a failed validation sends the bug back to IN_PROGRESS;
--   * testing -> review -> QA -> resolved each need written evidence, and the reviewer and verifier are never the person
--     who made the fix; RESOLVED also needs an applied fix whose validation passed.
-- Nothing is ever pushed to a git provider: the patch is a stored diff the team applies in their own repository.

create table public.repository_bug_fixes (
  id              uuid primary key default gen_random_uuid(),
  bug_id          uuid not null references public.repository_bugs (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  project_id      uuid not null references public.projects (id) on delete cascade,
  version         integer not null check (version >= 1),
  status          text not null default 'PROPOSED' check (status in ('PROPOSED', 'CHANGES_REQUESTED', 'REJECTED', 'APPROVED', 'APPLIED', 'VALIDATION_FAILED', 'SUPERSEDED')),
  plan            jsonb not null check (jsonb_typeof(plan) = 'object' and octet_length(plan::text) <= 32768),
  edits           jsonb not null check (jsonb_typeof(edits) = 'array' and octet_length(edits::text) <= 65536),
  diff            text not null check (char_length(diff) between 1 and 200000),
  validation      jsonb check (validation is null or (jsonb_typeof(validation) = 'object' and octet_length(validation::text) <= 16384)),
  model           text check (char_length(model) <= 100),
  run_id          uuid references public.ai_runs (id) on delete set null,
  decided_by      uuid references auth.users (id) on delete set null,
  decided_at      timestamptz,
  decision_note   text check (char_length(decision_note) <= 1000),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint repository_bug_fixes_version_key unique (bug_id, version)
);
create index repository_bug_fixes_bug_idx on public.repository_bug_fixes (bug_id, version desc);
create trigger repository_bug_fixes_set_updated_at before update on public.repository_bug_fixes for each row execute function public.set_updated_at();

create table public.repository_bug_fix_files (
  fix_id          uuid not null references public.repository_bug_fixes (id) on delete cascade,
  path            text not null check (char_length(path) between 1 and 1024),
  base_hash       text not null check (base_hash ~ '^[0-9a-f]{64}$'),
  patched_content text not null check (octet_length(patched_content) <= 1048576),
  patched_hash    text not null check (patched_hash ~ '^[0-9a-f]{64}$'),
  primary key (fix_id, path)
);

alter table public.repository_bug_fixes enable row level security;
alter table public.repository_bug_fix_files enable row level security;
create policy "repository_bug_fixes_select_bug_visible" on public.repository_bug_fixes for select to authenticated
  using (exists (select 1 from public.repository_bugs b where b.id = repository_bug_fixes.bug_id));
create policy "repository_bug_fix_files_select_fix_visible" on public.repository_bug_fix_files for select to authenticated
  using (exists (select 1 from public.repository_bug_fixes f where f.id = repository_bug_fix_files.fix_id));
revoke all on public.repository_bug_fixes, public.repository_bug_fix_files from anon, authenticated;
grant select on public.repository_bug_fixes, public.repository_bug_fix_files to authenticated;

-- Tells every other active member who can see the project (at most 30), e.g. when a review or QA is requested. Internal.
create or replace function private.notify_bug_audience(p_bug public.repository_bugs, p_type text, p_title text, p_body text, p_exclude uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select m.user_id from public.organization_members m
           where m.organization_id = p_bug.organization_id and m.status = 'ACTIVE' and m.user_id is distinct from p_exclude
             and private.user_can_see_project(m.user_id, p_bug.project_id) limit 30 loop
    perform private.notify_member(r.user_id, p_bug.organization_id, p_type, p_title, p_body, private.bug_link(p_bug.id),
      p_type || ':' || p_bug.id || ':' || r.user_id || ':' || extract(epoch from clock_timestamp())::bigint);
  end loop;
end;
$$;
revoke all on function private.notify_bug_audience(public.repository_bugs, text, text, text, uuid) from public, anon, authenticated;

create or replace function private.bug_actor_can_work(p_bug public.repository_bugs)
returns boolean language sql stable security definer set search_path = '' as $$
  select (select auth.uid()) is not null
     and (p_bug.assigned_to = (select auth.uid()) or coalesce(private.caller_org_role(p_bug.organization_id), '') in ('OWNER', 'ADMIN'));
$$;
revoke all on function private.bug_actor_can_work(public.repository_bugs) from public, anon, authenticated;

-- The AI's proposal, stored for approval. p_files: [{path, base_hash, patched_content, patched_hash}].
create or replace function public.propose_bug_fix(p_bug_id uuid, p_plan jsonb, p_edits jsonb, p_diff text, p_files jsonb, p_model text, p_run_id uuid)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_bug public.repository_bugs;
  v_file jsonb;
  v_version integer;
  v_id uuid;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_bug from public.repository_bugs b where b.id = p_bug_id for update;
  if v_bug.id is null or not public.can_see_project(v_bug.project_id) then raise exception 'Bug not found' using errcode = '42501'; end if;
  if not private.bug_actor_can_work(v_bug) then raise exception 'Only the assignee or an admin can propose a fix' using errcode = '42501'; end if;
  if v_bug.status <> 'IN_PROGRESS' then raise exception 'Start work on the bug before proposing a fix' using errcode = '55000'; end if;
  if p_files is null or jsonb_typeof(p_files) <> 'array' or jsonb_array_length(p_files) not between 1 and 3 then raise exception 'Invalid fix files' using errcode = '22023'; end if;
  if p_run_id is not null and not exists (select 1 from public.ai_runs r where r.id = p_run_id and r.requested_by = v_user) then
    raise exception 'Invalid run' using errcode = '22023';
  end if;

  for v_file in select e from jsonb_array_elements(p_files) as e loop
    if not exists (select 1 from public.repository_files f where f.snapshot_id = v_bug.snapshot_id and f.path = v_file ->> 'path' and f.content_hash = v_file ->> 'base_hash') then
      raise exception 'The patch is not based on the stored file' using errcode = '22023';
    end if;
    if encode(sha256(convert_to(v_file ->> 'patched_content', 'UTF8')), 'hex') <> v_file ->> 'patched_hash' then
      raise exception 'Patched content does not match its hash' using errcode = '22023';
    end if;
  end loop;

  update public.repository_bug_fixes f set status = 'SUPERSEDED' where f.bug_id = p_bug_id and f.status in ('PROPOSED', 'CHANGES_REQUESTED', 'APPROVED');
  select coalesce(max(f.version), 0) + 1 into v_version from public.repository_bug_fixes f where f.bug_id = p_bug_id;
  insert into public.repository_bug_fixes (bug_id, organization_id, project_id, version, plan, edits, diff, model, run_id, created_by)
  values (p_bug_id, v_bug.organization_id, v_bug.project_id, v_version, p_plan, p_edits, p_diff, left(p_model, 100), p_run_id, v_user)
  returning id into v_id;
  for v_file in select e from jsonb_array_elements(p_files) as e loop
    insert into public.repository_bug_fix_files (fix_id, path, base_hash, patched_content, patched_hash)
    values (v_id, v_file ->> 'path', v_file ->> 'base_hash', v_file ->> 'patched_content', v_file ->> 'patched_hash');
  end loop;

  update public.repository_bugs b set status = 'AWAITING_APPROVAL' where b.id = p_bug_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (p_bug_id, v_user, 'fix_proposed', 'IN_PROGRESS', 'FIX_PROPOSED', jsonb_build_object('fix_id', v_id, 'version', v_version, 'model', left(p_model, 100))),
         (p_bug_id, v_user, 'awaiting_approval', 'FIX_PROPOSED', 'AWAITING_APPROVAL', jsonb_build_object('fix_id', v_id));
  if v_bug.assigned_to is not null and v_bug.assigned_to <> v_user then
    perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.fix_proposed', 'Fix awaiting your approval: ' || left(v_bug.title, 100),
      'A fix plan and patch were prepared. Review and approve or reject it.', private.bug_link(p_bug_id), 'bug.fix_proposed:' || v_id);
  end if;
  return v_id;
end;
$$;

create or replace function public.decide_bug_fix(p_fix_id uuid, p_decision text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_fix public.repository_bug_fixes;
  v_bug public.repository_bugs;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_fix from public.repository_bug_fixes f where f.id = p_fix_id for update;
  if v_fix.id is null then raise exception 'Fix not found' using errcode = '42501'; end if;
  select * into v_bug from public.repository_bugs b where b.id = v_fix.bug_id for update;
  if not public.can_see_project(v_bug.project_id) then raise exception 'Fix not found' using errcode = '42501'; end if;
  if not private.bug_actor_can_work(v_bug) then raise exception 'Only the assignee or an admin can decide on a fix' using errcode = '42501'; end if;
  if v_fix.status <> 'PROPOSED' or v_bug.status <> 'AWAITING_APPROVAL' then raise exception 'This fix is not awaiting a decision' using errcode = '55000'; end if;
  if p_decision not in ('APPROVE', 'REJECT', 'REQUEST_CHANGES') then raise exception 'Invalid decision' using errcode = '22023'; end if;
  if p_decision <> 'APPROVE' and char_length(v_note) < 3 then raise exception 'Say why' using errcode = '22023'; end if;

  update public.repository_bug_fixes f set status = case p_decision when 'APPROVE' then 'APPROVED' when 'REJECT' then 'REJECTED' else 'CHANGES_REQUESTED' end,
    decided_by = v_user, decided_at = now(), decision_note = nullif(v_note, '') where f.id = p_fix_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (v_bug.id, v_user, case p_decision when 'APPROVE' then 'fix_approved' when 'REJECT' then 'fix_rejected' else 'fix_changes_requested' end,
          'AWAITING_APPROVAL', case p_decision when 'APPROVE' then 'AWAITING_APPROVAL' else 'IN_PROGRESS' end, jsonb_build_object('fix_id', p_fix_id, 'note', v_note));
  if p_decision <> 'APPROVE' then update public.repository_bugs b set status = 'IN_PROGRESS' where b.id = v_bug.id; end if;
end;
$$;

-- Records the validation of an approved fix (computed by the server from the stored patched files) and applies it to
-- the working copy: passed -> FIX_APPLIED, failed -> back to IN_PROGRESS.
create or replace function public.record_bug_fix_validation(p_fix_id uuid, p_validation jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_fix public.repository_bug_fixes;
  v_bug public.repository_bugs;
  v_passed boolean;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_fix from public.repository_bug_fixes f where f.id = p_fix_id for update;
  if v_fix.id is null then raise exception 'Fix not found' using errcode = '42501'; end if;
  select * into v_bug from public.repository_bugs b where b.id = v_fix.bug_id for update;
  if not public.can_see_project(v_bug.project_id) then raise exception 'Fix not found' using errcode = '42501'; end if;
  if not private.bug_actor_can_work(v_bug) then raise exception 'Only the assignee or an admin can apply a fix' using errcode = '42501'; end if;
  if v_fix.status <> 'APPROVED' or v_bug.status <> 'AWAITING_APPROVAL' then raise exception 'Only an approved fix can be applied' using errcode = '55000'; end if;
  if p_validation is null or jsonb_typeof(p_validation) <> 'object' or jsonb_typeof(p_validation -> 'passed') <> 'boolean'
     or jsonb_typeof(p_validation -> 'checks') <> 'array' or jsonb_array_length(p_validation -> 'checks') not between 1 and 10 then
    raise exception 'Invalid validation' using errcode = '22023';
  end if;
  v_passed := (p_validation ->> 'passed')::boolean;
  -- "passed" must agree with the individual checks: any FAIL means the fix did not pass.
  if v_passed and exists (select 1 from jsonb_array_elements(p_validation -> 'checks') c where c ->> 'status' = 'FAIL') then
    raise exception 'Validation contradicts its checks' using errcode = '22023';
  end if;

  update public.repository_bug_fixes f set status = case when v_passed then 'APPLIED' else 'VALIDATION_FAILED' end, validation = p_validation where f.id = p_fix_id;
  update public.repository_bugs b set status = case when v_passed then 'FIX_APPLIED' else 'IN_PROGRESS' end where b.id = v_bug.id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (v_bug.id, v_user, case when v_passed then 'fix_applied' else 'fix_validation_failed' end, 'AWAITING_APPROVAL',
          case when v_passed then 'FIX_APPLIED' else 'IN_PROGRESS' end, jsonb_build_object('fix_id', p_fix_id, 'passed', v_passed));
end;
$$;

-- All status moves outside the fix steps above. Replaces the version of migration 20261029000003 with the review stages.
create or replace function public.transition_bug(p_bug_id uuid, p_to text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_bug public.repository_bugs;
  v_admin boolean;
  v_worker boolean;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
  v_clears boolean := p_to in ('TRIAGED', 'REJECTED', 'CANCELLED', 'REOPENED');
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_bug from public.repository_bugs b where b.id = p_bug_id for update;
  if v_bug.id is null or not public.can_see_project(v_bug.project_id) then raise exception 'Bug not found' using errcode = '42501'; end if;
  v_admin := coalesce(private.caller_org_role(v_bug.organization_id), '') in ('OWNER', 'ADMIN');
  v_worker := v_admin or v_bug.assigned_to = v_user;
  if not private.bug_transition_ok(v_bug.status, p_to) then raise exception 'That status change is not allowed' using errcode = '55000'; end if;

  if p_to in ('FIX_PROPOSED', 'AWAITING_APPROVAL', 'FIX_APPLIED') then
    raise exception 'Use the fix workflow for that stage' using errcode = '55000';

  elsif p_to = 'IN_PROGRESS' and v_bug.status in ('CODE_REVIEW', 'QA_VERIFICATION', 'TESTING') then
    -- Sending work back: the reviewer or verifier (never the fixer alone) or an admin, with the reason.
    if not (v_admin or v_bug.assigned_to is distinct from v_user or v_bug.status = 'TESTING') then raise exception 'Only a reviewer can send it back' using errcode = '42501'; end if;
    if v_bug.status = 'TESTING' and not v_worker then raise exception 'Only the assignee or an admin can do that' using errcode = '42501'; end if;
    if char_length(v_note) < 3 then raise exception 'Say what needs more work' using errcode = '22023'; end if;

  elsif p_to in ('IN_PROGRESS', 'BLOCKED') then
    if not v_worker then raise exception 'Only the assignee or an admin can do that' using errcode = '42501'; end if;
    if p_to = 'BLOCKED' and char_length(v_note) < 3 then raise exception 'Say what blocks it' using errcode = '22023'; end if;

  elsif p_to = 'TESTING' then
    if not v_worker then raise exception 'Only the assignee or an admin can do that' using errcode = '42501'; end if;
    if not exists (select 1 from public.repository_bug_fixes f where f.bug_id = p_bug_id and f.status = 'APPLIED') then
      raise exception 'There is no applied, validated fix to test' using errcode = '55000';
    end if;

  elsif p_to = 'CODE_REVIEW' then
    if not v_worker then raise exception 'Only the assignee or an admin can do that' using errcode = '42501'; end if;
    if char_length(v_note) < 10 then raise exception 'Describe how the fix was tested and the result' using errcode = '22023'; end if;

  elsif p_to = 'QA_VERIFICATION' then
    if v_bug.assigned_to = v_user then raise exception 'The person who made the fix cannot review it' using errcode = '42501'; end if;
    if char_length(v_note) < 10 then raise exception 'Describe the review outcome' using errcode = '22023'; end if;

  elsif p_to = 'RESOLVED' then
    if v_bug.assigned_to = v_user then raise exception 'The person who made the fix cannot verify it' using errcode = '42501'; end if;
    if char_length(v_note) < 10 then raise exception 'Describe the evidence that the bug is fixed' using errcode = '22023'; end if;
    if not exists (select 1 from public.repository_bug_fixes f where f.bug_id = p_bug_id and f.status = 'APPLIED' and (f.validation ->> 'passed')::boolean) then
      raise exception 'A bug cannot be resolved without an applied fix that passed validation' using errcode = '55000';
    end if;

  elsif v_clears then
    if not v_admin then raise exception 'Only an owner or admin can do that' using errcode = '42501'; end if;
    if p_to <> 'TRIAGED' and char_length(v_note) < 3 then raise exception 'A reason is required' using errcode = '22023'; end if;
  else
    raise exception 'Use the fix workflow for that stage' using errcode = '55000';
  end if;

  update public.repository_bugs b set status = p_to,
    assigned_to = case when v_clears then null else b.assigned_to end,
    assigned_at = case when v_clears then null else b.assigned_at end,
    assignment_source = case when v_clears then null else b.assignment_source end
  where b.id = p_bug_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (p_bug_id, v_user, 'status_changed', v_bug.status, p_to, jsonb_build_object('note', v_note));

  if p_to = 'BLOCKED' then
    perform private.notify_member(m.user_id, v_bug.organization_id, 'bug.blocked', 'Bug blocked: ' || left(v_bug.title, 120), v_note, private.bug_link(p_bug_id),
      'bug.blocked:' || p_bug_id || ':' || m.user_id || ':' || extract(epoch from clock_timestamp())::bigint)
    from public.organization_members m where m.organization_id = v_bug.organization_id and m.role in ('OWNER', 'ADMIN') and m.status = 'ACTIVE';
  elsif p_to = 'CODE_REVIEW' then
    perform private.notify_bug_audience(v_bug, 'bug.review_requested', 'Code review requested: ' || left(v_bug.title, 100), v_note, v_bug.assigned_to);
  elsif p_to = 'QA_VERIFICATION' then
    perform private.notify_bug_audience(v_bug, 'bug.qa_requested', 'QA verification requested: ' || left(v_bug.title, 100), v_note, v_user);
  elsif p_to = 'RESOLVED' then
    perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.resolved', 'Bug resolved: ' || left(v_bug.title, 120), v_note, private.bug_link(p_bug_id),
      'bug.resolved:' || p_bug_id || ':' || extract(epoch from clock_timestamp())::bigint);
  elsif v_bug.assigned_to is not null and v_bug.assigned_to <> v_user then
    perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.status', 'Bug moved to ' || lower(replace(p_to, '_', ' ')) || ': ' || left(v_bug.title, 100), v_note,
      private.bug_link(p_bug_id), 'bug.status:' || p_bug_id || ':' || p_to || ':' || extract(epoch from clock_timestamp())::bigint);
  end if;
end;
$$;

revoke all on function public.propose_bug_fix(uuid, jsonb, jsonb, text, jsonb, text, uuid) from public, anon;
revoke all on function public.decide_bug_fix(uuid, text, text) from public, anon;
revoke all on function public.record_bug_fix_validation(uuid, jsonb) from public, anon;
revoke all on function public.transition_bug(uuid, text, text) from public, anon;
grant execute on function public.propose_bug_fix(uuid, jsonb, jsonb, text, jsonb, text, uuid) to authenticated;
grant execute on function public.decide_bug_fix(uuid, text, text) to authenticated;
grant execute on function public.record_bug_fix_validation(uuid, jsonb) to authenticated;
grant execute on function public.transition_bug(uuid, text, text) to authenticated;
