-- Phases 7-8 completion (2026-10-18): QA stage, defect records, mentions, deadline notifications, repository/PR links
-- on tasks, declining an assignment, managers told when nobody is eligible, a due-date/QA-policy activity entry, and
-- a requirement cannot be completed while its tasks are open. Additive: the task status set is extended (existing
-- rows stay valid), new columns have safe defaults (qa_required false keeps today's behaviour for every task), new
-- tables, and replaced function bodies. add_task_comment gains an optional p_mentions argument (old calls still work).
--
-- Lifecycle after this migration (transition_task() decides who may take each step):
--   TODO        -> IN_PROGRESS | CANCELLED
--   IN_PROGRESS -> BLOCKED | IN_REVIEW | COMPLETED (manager, only when QA is not required) | TODO | CANCELLED
--   BLOCKED     -> IN_PROGRESS | CANCELLED
--   IN_REVIEW   -> IN_QA (review approved, QA next) | COMPLETED (approved, only when QA is not required)
--                  | IN_PROGRESS (changes requested, reason) | CANCELLED
--   IN_QA       -> COMPLETED (tests passed) | IN_PROGRESS (defect found, reason) | CANCELLED
--   COMPLETED   -> IN_PROGRESS (reopen; also when a defect is reported);  CANCELLED -> TODO
-- Testers: managers, and members of the task's responsible team other than the assignee (after a handoff to a QA
-- team, that team). A task with open defects cannot enter QA or be completed.
--
-- Rollback: map IN_QA rows back to IN_REVIEW, restore the previous bodies from 20261024000001, drop the new tables,
-- functions and the qa_required column.

-- 1. Columns and status set ---------------------------------------------------------------------------------------
alter table public.tasks add column qa_required boolean not null default false;
grant update (qa_required) on public.tasks to authenticated;  -- tasks_update_admin RLS: managers only

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA', 'COMPLETED', 'CANCELLED'));

create or replace function public.enforce_task_status_transition()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not (
    (old.status = 'TODO'        and new.status in ('IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'IN_PROGRESS' and new.status in ('BLOCKED', 'IN_REVIEW', 'COMPLETED', 'TODO', 'CANCELLED')) or
    (old.status = 'BLOCKED'     and new.status in ('IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'IN_REVIEW'   and new.status in ('IN_QA', 'COMPLETED', 'IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'IN_QA'       and new.status in ('COMPLETED', 'IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'COMPLETED'   and new.status = 'IN_PROGRESS') or
    (old.status = 'CANCELLED'   and new.status = 'TODO')
  ) then
    raise exception 'Invalid task status transition: % -> %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;

alter table public.task_events drop constraint if exists task_events_event_type_check;
alter table public.task_events add constraint task_events_event_type_check
  check (event_type in ('CREATED', 'STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'COMMENTED', 'DEPENDENCY_ADDED',
    'DEPENDENCY_REMOVED', 'SKILLS_CHANGED', 'HANDOFF_CREATED', 'HANDOFF_ACCEPTED', 'HANDOFF_DECLINED', 'HANDOFF_CANCELLED',
    'DECLINED', 'DEFECT_REPORTED', 'DEFECT_RESOLVED', 'DUE_DATE_CHANGED', 'QA_REQUIREMENT_CHANGED', 'LINK_ADDED', 'LINK_REMOVED'));

-- 2. Defects and links ------------------------------------------------------------------------------------------
create table public.task_defects (
  id          uuid primary key default gen_random_uuid(),
  task_id     uuid not null references public.tasks (id) on delete cascade,
  title       text not null check (char_length(btrim(title)) between 1 and 200),
  details     text check (char_length(details) <= 4000),
  severity    text not null default 'MEDIUM' check (severity in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL')),
  status      text not null default 'OPEN' check (status in ('OPEN', 'RESOLVED')),
  reported_by uuid references auth.users (id) on delete set null,
  reported_at timestamptz not null default now(),
  resolved_by uuid references auth.users (id) on delete set null,
  resolved_at timestamptz,
  resolution  text check (char_length(resolution) <= 2000),
  constraint task_defects_resolved check ((status = 'RESOLVED') = (resolved_at is not null))
);
create index task_defects_task_idx on public.task_defects (task_id, status);

create table public.task_links (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  url        text not null check (url ~ '^https://[^[:space:]<>"]+$' and char_length(url) <= 500),
  label      text check (char_length(label) <= 120),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index task_links_task_idx on public.task_links (task_id);

alter table public.task_defects enable row level security;
alter table public.task_links enable row level security;
create policy "task_defects_select" on public.task_defects for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_defects.task_id));
create policy "task_links_select" on public.task_links for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_links.task_id));
revoke all on public.task_defects, public.task_links from anon, authenticated;
grant select on public.task_defects, public.task_links to authenticated;

-- 3. Helpers -------------------------------------------------------------------------------------------------------
create or replace function private.open_defects(p_task_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.task_defects d where d.task_id = p_task_id and d.status = 'OPEN';
$$;

-- Responsible team of a task: its own team, else the project's team.
create or replace function private.task_team(p_task_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(k.team_id, p.team_id) from public.tasks k join public.requirements r on r.id = k.requirement_id
  join public.projects p on p.id = r.project_id where k.id = p_task_id;
$$;

-- May the caller test the task (QA)? A manager, or an active member of the responsible team who is not the assignee.
create or replace function private.can_test_task(p_task_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.has_org_role(private.task_org(p_task_id), array['OWNER', 'ADMIN'])
      or (public.is_org_member(private.task_org(p_task_id))
          and exists (select 1 from public.team_members tm where tm.team_id = private.task_team(p_task_id) and tm.user_id = (select auth.uid()))
          and (select k.assignee_id from public.tasks k where k.id = p_task_id) is distinct from (select auth.uid()));
$$;

-- Notify every active manager of the task's organization (except the actor).
create or replace function private.notify_task_managers(p_task_id uuid, p_type text, p_title text, p_body text, p_dedupe text)
returns void language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in select m.user_id from public.organization_members m
           where m.organization_id = private.task_org(p_task_id) and m.role in ('OWNER', 'ADMIN') and m.status = 'ACTIVE' limit 50 loop
    perform private.notify_task(r.user_id, p_task_id, p_type, p_title, p_body, p_dedupe || ':' || r.user_id);
  end loop;
end;
$$;

revoke all on function private.open_defects(uuid) from public, anon, authenticated;
revoke all on function private.task_team(uuid) from public, anon, authenticated;
revoke all on function private.can_test_task(uuid) from public, anon, authenticated;
revoke all on function private.notify_task_managers(uuid, text, text, text, text) from public, anon, authenticated;

-- 4. Activity for planning changes made through the column-level UPDATE grant --------------------------------------
create or replace function private.log_task_planning_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.due_date is distinct from old.due_date then
    insert into public.task_events (task_id, actor_id, event_type, details)
    values (new.id, (select auth.uid()), 'DUE_DATE_CHANGED', jsonb_strip_nulls(jsonb_build_object('from', old.due_date, 'to', new.due_date)));
  end if;
  if new.qa_required is distinct from old.qa_required then
    insert into public.task_events (task_id, actor_id, event_type, details)
    values (new.id, (select auth.uid()), 'QA_REQUIREMENT_CHANGED', jsonb_build_object('qa_required', new.qa_required));
  end if;
  return new;
end;
$$;
revoke all on function private.log_task_planning_change() from public, anon, authenticated;
create trigger tasks_log_planning_change after update of due_date, qa_required on public.tasks
  for each row execute function private.log_task_planning_change();

-- 5. A requirement is complete only when its tasks are -------------------------------------------------------------
create or replace function private.enforce_requirement_completion()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'COMPLETED' and old.status is distinct from 'COMPLETED'
     and exists (select 1 from public.tasks k where k.requirement_id = new.id and k.status not in ('COMPLETED', 'CANCELLED')) then
    raise exception 'Every task of the requirement must be completed or cancelled first' using errcode = '55000';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_requirement_completion() from public, anon, authenticated;
create trigger requirements_enforce_completion before update of status on public.requirements
  for each row execute function private.enforce_requirement_completion();

-- 6. Status workflow with QA ---------------------------------------------------------------------------------------
create or replace function public.transition_task(p_task_id uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_task     public.tasks;
  v_user     uuid := (select auth.uid());
  v_manager  boolean;
  v_assignee boolean;
  v_tester   boolean;
  v_reason   text := nullif(btrim(p_reason), '');
  v_event    bigint;
  r          record;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.id is null or not private.user_can_see_project(v_user, private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_status not in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA', 'COMPLETED', 'CANCELLED') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  if p_status = v_task.status then return; end if;
  v_manager := public.has_org_role(private.task_org(p_task_id), array['OWNER', 'ADMIN']);
  v_assignee := v_task.assignee_id = v_user;
  v_tester := private.can_test_task(p_task_id);

  -- Who may take which step. The assignee does the work; testers pass or fail QA; managers may do everything.
  if not (
       v_manager
       or (v_assignee and (
            (v_task.status = 'TODO' and p_status = 'IN_PROGRESS') or
            (v_task.status = 'IN_PROGRESS' and p_status in ('BLOCKED', 'IN_REVIEW', 'TODO')) or
            (v_task.status = 'BLOCKED' and p_status = 'IN_PROGRESS')))
       or (v_tester and v_task.status = 'IN_QA' and p_status in ('COMPLETED', 'IN_PROGRESS'))
     ) then
    raise exception 'You cannot move this task from % to %', v_task.status, p_status using errcode = '42501';
  end if;
  if p_status in ('BLOCKED', 'CANCELLED') and v_reason is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if v_task.status = 'IN_REVIEW' and p_status = 'IN_PROGRESS' and v_reason is null then
    raise exception 'Describe the requested changes' using errcode = '22023';
  end if;
  if v_task.status = 'IN_QA' and p_status = 'IN_PROGRESS' and v_reason is null then
    raise exception 'Describe what failed in testing' using errcode = '22023';
  end if;
  if p_status = 'IN_PROGRESS' and v_task.status = 'TODO' and v_task.assignee_id is null then
    raise exception 'Assign the task before starting it' using errcode = '55000';
  end if;
  if p_status in ('IN_PROGRESS', 'IN_REVIEW', 'IN_QA', 'COMPLETED') and v_task.status in ('TODO', 'BLOCKED', 'IN_PROGRESS', 'IN_REVIEW')
     and private.open_dependencies(p_task_id) > 0 then
    raise exception 'Waiting for % unfinished dependenc%', private.open_dependencies(p_task_id),
      case when private.open_dependencies(p_task_id) = 1 then 'y' else 'ies' end using errcode = '55000';
  end if;
  if p_status = 'COMPLETED' and v_task.qa_required and v_task.status <> 'IN_QA' then
    raise exception 'This task requires QA: approve the review to send it to testing' using errcode = '55000';
  end if;
  if p_status in ('IN_QA', 'COMPLETED') and private.open_defects(p_task_id) > 0 then
    raise exception '% open defect% must be resolved first', private.open_defects(p_task_id),
      case when private.open_defects(p_task_id) = 1 then '' else 's' end using errcode = '55000';
  end if;

  update public.tasks k set status = p_status where k.id = p_task_id;  -- the lifecycle trigger validates the step
  v_event := private.log_task_event(p_task_id, 'STATUS_CHANGED', v_task.status, p_status,
                                    jsonb_strip_nulls(jsonb_build_object('reason', left(v_reason, 1000))));

  if p_status = 'BLOCKED' then
    perform private.notify_task(v_task.assigned_by, p_task_id, 'task.blocked', 'Blocked: ' || v_task.title, v_reason, 'task.blocked:' || v_event);
    perform private.notify_task(v_task.created_by, p_task_id, 'task.blocked', 'Blocked: ' || v_task.title, v_reason, 'task.blocked:' || v_event);
  elsif p_status = 'IN_REVIEW' then
    perform private.notify_task(v_task.assigned_by, p_task_id, 'task.review_requested', 'Review requested: ' || v_task.title, null, 'task.review:' || v_event);
    perform private.notify_task(v_task.created_by, p_task_id, 'task.review_requested', 'Review requested: ' || v_task.title, null, 'task.review:' || v_event);
  elsif p_status = 'IN_QA' then
    -- The responsible team tests it (the assignee is told it passed review).
    for r in select tm.user_id from public.team_members tm where tm.team_id = private.task_team(p_task_id) limit 200 loop
      if r.user_id is distinct from v_task.assignee_id then
        perform private.notify_task(r.user_id, p_task_id, 'task.qa_requested', 'Ready for QA: ' || v_task.title, null, 'task.qa:' || v_event);
      end if;
    end loop;
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.review_approved', 'Review approved, now in QA: ' || v_task.title, null, 'task.approved:' || v_event);
  elsif v_task.status = 'IN_REVIEW' and p_status = 'IN_PROGRESS' then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.changes_requested', 'Changes requested: ' || v_task.title, v_reason, 'task.changes:' || v_event);
  elsif v_task.status = 'IN_QA' and p_status = 'IN_PROGRESS' then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.qa_failed', 'Failed QA: ' || v_task.title, v_reason, 'task.qa_failed:' || v_event);
  elsif p_status = 'COMPLETED' then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.completed', 'Completed: ' || v_task.title, null, 'task.completed:' || v_event);
    for r in select k.id, k.assignee_id, k.title from public.task_dependencies td join public.tasks k on k.id = td.task_id
             where td.depends_on_task_id = p_task_id and k.status not in ('COMPLETED', 'CANCELLED') loop
      if private.open_dependencies(r.id) = 0 then
        perform private.notify_task(r.assignee_id, r.id, 'task.dependencies_done', 'Ready to start: ' || r.title,
          'All tasks it depends on are finished.', 'task.ready:' || r.id || ':' || v_event);
      end if;
    end loop;
  end if;
end;
$$;

-- 7. Defects -------------------------------------------------------------------------------------------------------
-- A tester reports a defect on a task in QA, or on a completed task (which reopens it). The task goes back to
-- IN_PROGRESS for the assignee.
create or replace function public.report_task_defect(p_task_id uuid, p_title text, p_details text, p_severity text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_task  public.tasks;
  v_id    uuid;
  v_title text := btrim(p_title);
  v_event bigint;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.id is null or not private.user_can_see_project((select auth.uid()), private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not private.can_test_task(p_task_id) then
    raise exception 'Only testers (the responsible team, not the assignee) or admins can report defects' using errcode = '42501';
  end if;
  if v_task.status not in ('IN_QA', 'COMPLETED') then
    raise exception 'Defects are reported on tasks in QA or completed tasks' using errcode = '55000';
  end if;
  if v_title is null or char_length(v_title) not between 1 and 200 then raise exception 'A title of 1-200 characters is required' using errcode = '22023'; end if;
  if p_details is not null and char_length(p_details) > 4000 then raise exception 'Details are limited to 4000 characters' using errcode = '22023'; end if;
  if coalesce(p_severity, 'MEDIUM') not in ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL') then raise exception 'Invalid severity' using errcode = '22023'; end if;
  if (select count(*) from public.task_defects d where d.task_id = p_task_id) >= 200 then raise exception 'Too many defects on this task' using errcode = '54000'; end if;

  insert into public.task_defects (task_id, title, details, severity, reported_by)
  values (p_task_id, v_title, nullif(btrim(p_details), ''), coalesce(p_severity, 'MEDIUM'), (select auth.uid()))
  returning id into v_id;
  perform private.log_task_event(p_task_id, 'DEFECT_REPORTED', null, null,
    jsonb_build_object('defect_id', v_id, 'severity', coalesce(p_severity, 'MEDIUM'), 'title', left(v_title, 200)));
  update public.tasks k set status = 'IN_PROGRESS' where k.id = p_task_id;
  v_event := private.log_task_event(p_task_id, 'STATUS_CHANGED', v_task.status, 'IN_PROGRESS',
    jsonb_build_object('reason', left('Defect: ' || v_title, 1000)));
  perform private.notify_task(v_task.assignee_id, p_task_id, 'task.defect_reported', 'Defect reported: ' || v_task.title,
    left(v_title, 300), 'task.defect:' || v_id);
  return v_id;
end;
$$;

-- The assignee or a manager resolves a defect; the reporter is told.
create or replace function public.resolve_task_defect(p_defect_id uuid, p_resolution text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_def  public.task_defects;
  v_task public.tasks;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_def from public.task_defects d where d.id = p_defect_id for update;
  if v_def.id is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_task from public.tasks k where k.id = v_def.task_id;
  if not (v_task.assignee_id = (select auth.uid()) or public.has_org_role(private.task_org(v_task.id), array['OWNER', 'ADMIN'])) then
    raise exception 'Only the assignee or an admin can resolve a defect' using errcode = '42501';
  end if;
  if v_def.status = 'RESOLVED' then return; end if;
  if p_resolution is not null and char_length(p_resolution) > 2000 then raise exception 'The resolution is limited to 2000 characters' using errcode = '22023'; end if;
  update public.task_defects d set status = 'RESOLVED', resolved_by = (select auth.uid()), resolved_at = now(),
         resolution = nullif(btrim(p_resolution), '') where d.id = v_def.id;
  perform private.log_task_event(v_task.id, 'DEFECT_RESOLVED', null, null, jsonb_build_object('defect_id', v_def.id));
  perform private.notify_task(v_def.reported_by, v_task.id, 'task.defect_resolved', 'Defect resolved: ' || v_def.title,
    left(nullif(btrim(p_resolution), ''), 300), 'task.defect_resolved:' || v_def.id);
end;
$$;

-- 8. Comments with mentions ----------------------------------------------------------------------------------------
drop function public.add_task_comment(uuid, text);
create function public.add_task_comment(p_task_id uuid, p_body text, p_mentions uuid[] default '{}')
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user     uuid := (select auth.uid());
  v_task     public.tasks;
  v_id       uuid;
  v_mentions uuid[] := array(select distinct m from unnest(coalesce(p_mentions, '{}')) m where m is not null);
  v_person   uuid;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id;
  if v_task.id is null or not private.user_can_see_project(v_user, private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'A comment must be 1-4000 characters' using errcode = '22023';
  end if;
  if coalesce(array_length(v_mentions, 1), 0) > 10 then raise exception 'Mention at most 10 people' using errcode = '22023'; end if;
  foreach v_person in array v_mentions loop
    if not private.user_can_see_project(v_person, private.task_project(p_task_id)) then
      raise exception 'A mentioned person cannot see this task' using errcode = '42501';
    end if;
  end loop;

  insert into public.task_comments (task_id, author_id, body) values (p_task_id, v_user, btrim(p_body)) returning id into v_id;
  perform private.log_task_event(p_task_id, 'COMMENTED', null, null,
    jsonb_strip_nulls(jsonb_build_object('comment_id', v_id, 'mentions', case when coalesce(array_length(v_mentions, 1), 0) > 0 then to_jsonb(v_mentions) end)));
  foreach v_person in array v_mentions loop
    perform private.notify_task(v_person, p_task_id, 'task.mentioned', 'You were mentioned: ' || v_task.title, left(btrim(p_body), 300), 'task.mention:' || v_id || ':' || v_person);
  end loop;
  if not (v_task.assignee_id = any (v_mentions)) then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.commented', 'New comment: ' || v_task.title, left(btrim(p_body), 300), 'task.comment:' || v_id);
  end if;
  return v_id;
end;
$$;

-- People who can be mentioned on a task: active members who can see its project. Any viewer of the task may ask.
create or replace function public.task_mention_candidates(p_task_id uuid)
returns table (user_id uuid, display_name text)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare v_project uuid := private.task_project(p_task_id);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_project is null or not private.user_can_see_project((select auth.uid()), v_project) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  return query
    select m.user_id, coalesce(w.full_name, nullif(btrim(p.display_name), ''), p.email)
    from public.organization_members m
    join public.profiles p on p.id = m.user_id
    left join public.workforce_profiles w on w.organization_id = m.organization_id and w.user_id = m.user_id
    where m.organization_id = private.project_org(v_project) and m.status = 'ACTIVE'
      and m.user_id <> (select auth.uid()) and private.user_can_see_project(m.user_id, v_project)
    order by 2
    limit 200;
end;
$$;

-- 9. Deadlines (no scheduler: generated for the caller when they open My work, Notifications or the dashboard) -------
create or replace function public.generate_deadline_notifications()
returns int language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  r record;
  v_n int := 0;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  for r in select k.id, k.title, k.due_date from public.tasks k
           where k.assignee_id = v_user and k.due_date is not null and k.due_date <= current_date + 2
             and k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA')
           limit 200 loop
    if not private.user_can_see_project(v_user, private.task_project(r.id)) then continue; end if;
    insert into public.notifications (user_id, organization_id, type, task_id, title, body, link, dedupe_key)
    values (v_user, private.task_org(r.id),
            case when r.due_date < current_date then 'task.overdue' else 'task.deadline' end, r.id,
            left(case when r.due_date < current_date then 'Overdue: ' else 'Due ' || to_char(r.due_date, 'YYYY-MM-DD') || ': ' end || r.title, 200),
            'Due date ' || to_char(r.due_date, 'YYYY-MM-DD') || '.', private.task_link(r.id),
            (case when r.due_date < current_date then 'task.overdue:' else 'task.deadline:' end) || r.id || ':' || r.due_date)
    on conflict (user_id, dedupe_key) do nothing;
    if found then v_n := v_n + 1; end if;
  end loop;
  return v_n;
end;
$$;

-- 10. Links to repositories, pull requests, documents ---------------------------------------------------------------
create or replace function public.add_task_link(p_task_id uuid, p_url text, p_label text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_task public.tasks;
  v_id uuid;
  v_url text := btrim(p_url);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id;
  if v_task.id is null or not private.user_can_see_project((select auth.uid()), private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not (v_task.assignee_id = (select auth.uid()) or public.has_org_role(private.task_org(p_task_id), array['OWNER', 'ADMIN'])) then
    raise exception 'Only the assignee or an admin can add links' using errcode = '42501';
  end if;
  if v_url is null or v_url !~ '^https://[^[:space:]<>"]+$' or char_length(v_url) > 500 then
    raise exception 'Use an https:// address of at most 500 characters' using errcode = '22023';
  end if;
  if p_label is not null and char_length(btrim(p_label)) > 120 then raise exception 'The label is limited to 120 characters' using errcode = '22023'; end if;
  if (select count(*) from public.task_links l where l.task_id = p_task_id) >= 20 then raise exception 'At most 20 links per task' using errcode = '54000'; end if;
  insert into public.task_links (task_id, url, label, created_by) values (p_task_id, v_url, nullif(btrim(p_label), ''), (select auth.uid()))
  returning id into v_id;
  perform private.log_task_event(p_task_id, 'LINK_ADDED', null, null, jsonb_build_object('link_id', v_id));
  return v_id;
end;
$$;

create or replace function public.remove_task_link(p_link_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_link public.task_links;
  v_task public.tasks;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_link from public.task_links l where l.id = p_link_id for update;
  if v_link.id is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_task from public.tasks k where k.id = v_link.task_id;
  if not (v_link.created_by = (select auth.uid()) or v_task.assignee_id = (select auth.uid())
          or public.has_org_role(private.task_org(v_task.id), array['OWNER', 'ADMIN'])) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  delete from public.task_links l where l.id = v_link.id;
  perform private.log_task_event(v_task.id, 'LINK_REMOVED', null, null, jsonb_build_object('link_id', v_link.id));
end;
$$;

-- 11. Assignment: decline, queue signals, IN_QA counts as active ----------------------------------------------------
-- The assignee declines a task they have not started (reason required). The task is unassigned and returns to the
-- assignment queue; whoever assigned it, and the organization's managers, are told.
create or replace function public.decline_task_assignment(p_task_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_task   public.tasks;
  v_reason text := nullif(btrim(p_reason), '');
  v_event  bigint;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.id is null or v_task.assignee_id is distinct from (select auth.uid()) then
    raise exception 'Only the assignee can decline a task' using errcode = '42501';
  end if;
  if v_task.status <> 'TODO' then raise exception 'Only a task that has not been started can be declined' using errcode = '55000'; end if;
  if v_reason is null then raise exception 'A reason is required' using errcode = '22023'; end if;
  update public.tasks k set assignee_id = null, assigned_by = null, assigned_at = null where k.id = p_task_id;
  v_event := private.log_task_event(p_task_id, 'DECLINED', null, null,
    jsonb_build_object('from', v_task.assignee_id, 'reason', left(v_reason, 500)));
  -- Same dedupe key format as notify_task_managers(), so a manager who also assigned it is told once.
  perform private.notify_task(v_task.assigned_by, p_task_id, 'task.assignment_declined', 'Assignment declined: ' || v_task.title, v_reason,
    'task.declined:' || v_event || ':' || v_task.assigned_by);
  perform private.notify_task_managers(p_task_id, 'task.assignment_declined', 'Assignment declined: ' || v_task.title, v_reason, 'task.declined:' || v_event);
end;
$$;

-- Called by automatic assignment when no eligible person exists: the other managers are told (once per task per day).
create or replace function public.report_unassignable_task(p_task_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_task public.tasks;
begin
  perform private.require_task_manager(p_task_id);
  select * into v_task from public.tasks k where k.id = p_task_id;
  if v_task.assignee_id is not null then return; end if;
  perform private.notify_task_managers(p_task_id, 'task.unassignable', 'Nobody eligible: ' || v_task.title,
    left(coalesce(nullif(btrim(p_reason), ''), 'No eligible person for automatic assignment.'), 500),
    'task.unassignable:' || p_task_id || ':' || current_date);
end;
$$;

create or replace function public.assign_task(
  p_task_id uuid, p_assignee uuid, p_expected_assignee uuid, p_mode text default 'MANUAL', p_reason text default null
)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_task    public.tasks;
  v_org     uuid;
  v_avail   text;
  v_event   bigint;
  v_status  text;
begin
  perform private.require_task_manager(p_task_id);
  if p_mode not in ('MANUAL', 'RECOMMENDED', 'AUTO') then raise exception 'Invalid mode' using errcode = '22023'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.assignee_id is distinct from p_expected_assignee then
    raise exception 'The assignment changed in the meantime; reload and try again' using errcode = '40001';
  end if;
  if v_task.status in ('COMPLETED', 'CANCELLED', 'IN_REVIEW', 'IN_QA') then
    raise exception 'A % task cannot be reassigned', v_task.status using errcode = '55000';
  end if;
  if p_assignee is not distinct from v_task.assignee_id then return; end if;

  v_org := private.task_org(p_task_id);
  if p_assignee is not null then
    if not exists (select 1 from public.organization_members m where m.organization_id = v_org and m.user_id = p_assignee and m.status = 'ACTIVE') then
      raise exception 'The assignee is not an active member of this organization' using errcode = '42501';
    end if;
    if not private.user_can_see_project(p_assignee, private.task_project(p_task_id)) then
      raise exception 'The assignee has no access to this project (not in its team or a collaborating team)' using errcode = '23514';
    end if;
    select w.availability into v_avail from public.workforce_profiles w where w.organization_id = v_org and w.user_id = p_assignee;
    if v_avail = 'UNAVAILABLE' then
      raise exception 'The assignee is marked unavailable' using errcode = '23514';
    end if;
  end if;

  v_status := case when v_task.status = 'IN_PROGRESS' then 'TODO' else v_task.status end;
  update public.tasks k set assignee_id = p_assignee, assigned_by = case when p_assignee is null then null else (select auth.uid()) end,
         assigned_at = case when p_assignee is null then null else now() end, status = v_status
  where k.id = p_task_id;

  v_event := private.log_task_event(p_task_id, case when p_assignee is null then 'UNASSIGNED' else 'ASSIGNED' end,
    case when v_status <> v_task.status then v_task.status end, case when v_status <> v_task.status then v_status end,
    jsonb_strip_nulls(jsonb_build_object('from', v_task.assignee_id, 'to', p_assignee, 'mode', p_mode, 'reason', left(p_reason, 500))));
  perform private.notify_task(p_assignee, p_task_id, 'task.assigned', 'Assigned to you: ' || v_task.title,
    coalesce(left(p_reason, 300), 'A task was assigned to you.'), 'task.assigned:' || v_event);
  perform private.notify_task(v_task.assignee_id, p_task_id, 'task.unassigned', 'Reassigned: ' || v_task.title,
    'This task is no longer assigned to you.', 'task.unassigned:' || v_event);
end;
$$;

create or replace function public.task_assignment_candidates(p_task_id uuid)
returns table (user_id uuid, display_name text, email text, availability text, job_title text, in_project_team boolean,
               matched_skills int, required_skills int, active_tasks int, active_hours numeric, unestimated_tasks int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_org uuid; v_project uuid; v_team uuid; v_required int;
begin
  perform private.require_task_manager(p_task_id);
  v_org := private.task_org(p_task_id);
  v_project := private.task_project(p_task_id);
  select coalesce(k.team_id, p.team_id) into v_team from public.tasks k join public.projects p on p.id = v_project where k.id = p_task_id;
  select count(*)::int into v_required from public.task_required_skills rs where rs.task_id = p_task_id;
  return query
    select m.user_id, coalesce(w.full_name, pr.display_name, pr.email), pr.email, coalesce(w.availability, 'AVAILABLE'),
           w.job_title,
           exists (select 1 from public.team_members tm where tm.team_id = v_team and tm.user_id = m.user_id),
           (select count(*)::int from public.task_required_skills rs
              join public.workforce_profile_skills ps on ps.skill_id = rs.skill_id and ps.profile_id = w.id
             where rs.task_id = p_task_id),
           v_required,
           (select count(*)::int from public.tasks k2 where k2.assignee_id = m.user_id
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA') and private.task_org(k2.id) = v_org),
           (select coalesce(sum(k2.estimated_hours), 0) from public.tasks k2 where k2.assignee_id = m.user_id
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA') and private.task_org(k2.id) = v_org),
           (select count(*)::int from public.tasks k2 where k2.assignee_id = m.user_id and k2.estimated_hours is null
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA') and private.task_org(k2.id) = v_org)
    from public.organization_members m
    join public.profiles pr on pr.id = m.user_id
    left join public.workforce_profiles w on w.organization_id = v_org and w.user_id = m.user_id
    where m.organization_id = v_org and m.status = 'ACTIVE' and private.user_can_see_project(m.user_id, v_project)
    order by m.user_id;
end;
$$;

-- Same columns as before; IN_QA counts as active, and in_review now counts review and QA together.
create or replace function public.organization_workload(p_organization_id uuid)
returns table (user_id uuid, active_tasks int, in_progress int, blocked int, in_review int, active_hours numeric, unestimated_tasks int, overdue int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform private.require_org_manager(p_organization_id);
  return query
    select m.user_id,
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA'))::int,
           count(k.id) filter (where k.status = 'IN_PROGRESS')::int,
           count(k.id) filter (where k.status = 'BLOCKED')::int,
           count(k.id) filter (where k.status in ('IN_REVIEW', 'IN_QA'))::int,
           coalesce(sum(k.estimated_hours) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA')), 0),
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA') and k.estimated_hours is null)::int,
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA') and k.due_date < current_date)::int
    from public.organization_members m
    left join public.tasks k on k.assignee_id = m.user_id and private.task_org(k.id) = p_organization_id
    where m.organization_id = p_organization_id
    group by m.user_id;
end;
$$;

-- 12. Privileges ---------------------------------------------------------------------------------------------------
revoke all on function public.report_task_defect(uuid, text, text, text) from public, anon;
revoke all on function public.resolve_task_defect(uuid, text) from public, anon;
revoke all on function public.add_task_comment(uuid, text, uuid[]) from public, anon;
revoke all on function public.task_mention_candidates(uuid) from public, anon;
revoke all on function public.generate_deadline_notifications() from public, anon;
revoke all on function public.add_task_link(uuid, text, text) from public, anon;
revoke all on function public.remove_task_link(uuid) from public, anon;
revoke all on function public.decline_task_assignment(uuid, text) from public, anon;
revoke all on function public.report_unassignable_task(uuid, text) from public, anon;
grant execute on function public.report_task_defect(uuid, text, text, text) to authenticated;
grant execute on function public.resolve_task_defect(uuid, text) to authenticated;
grant execute on function public.add_task_comment(uuid, text, uuid[]) to authenticated;
grant execute on function public.task_mention_candidates(uuid) to authenticated;
grant execute on function public.generate_deadline_notifications() to authenticated;
grant execute on function public.add_task_link(uuid, text, text) to authenticated;
grant execute on function public.remove_task_link(uuid) to authenticated;
grant execute on function public.decline_task_assignment(uuid, text) to authenticated;
grant execute on function public.report_unassignable_task(uuid, text) to authenticated;
