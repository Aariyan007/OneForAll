-- Task assignment and SDLC workflow: assignee and planning fields on tasks, required skills, review-aware lifecycle,
-- dependencies, comments, an activity log, cross-team handoffs (with collaborating teams per project), in-app
-- notifications, the organization's assignment mode, and workload/candidate reads for assignment.
-- Additive: existing rows stay valid (the new statuses extend the old set), no existing policy is altered.
--
-- Authority:
--   * OWNER/ADMIN of the task's organization ("managers"): plan, assign, review, cancel, manage dependencies.
--   * the assignee: start, block (with a reason), resume, submit for review, hand off.
--   * anyone who can see the task (project visibility, unchanged rule + collaborating teams): read, comment.
-- Status and assignee are no longer writable directly by clients; they change only through transition_task() and
-- assign_task(), which log an event and notify the people concerned.

-- 0. Collaborating teams -----------------------------------------------------------------------------------------
-- A project belongs to one team; other teams of the same organization can be added as collaborators (needed to hand
-- work to them). Members of a collaborating team see the project like members of its own team.
create table public.project_teams (
  project_id uuid not null references public.projects (id) on delete cascade,
  team_id    uuid not null references public.teams (id) on delete cascade,
  added_by   uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, team_id)
);
create index project_teams_team_idx on public.project_teams (team_id);

-- The organization of a project / team / task. Internal helpers (SECURITY DEFINER: they read across RLS).
create or replace function private.project_org(p_project_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select d.organization_id from public.projects p
  join public.teams t on t.id = p.team_id join public.departments d on d.id = t.department_id
  where p.id = p_project_id;
$$;
create or replace function private.team_org(p_team_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select d.organization_id from public.teams t join public.departments d on d.id = t.department_id where t.id = p_team_id;
$$;
create or replace function private.task_project(p_task_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select r.project_id from public.tasks k join public.requirements r on r.id = k.requirement_id where k.id = p_task_id;
$$;
revoke all on function private.project_org(uuid) from public, anon, authenticated;
revoke all on function private.team_org(uuid) from public, anon, authenticated;
revoke all on function private.task_project(uuid) from public, anon, authenticated;

create or replace function private.check_project_team_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if private.team_org(new.team_id) is distinct from private.project_org(new.project_id) then
    raise exception 'The team belongs to another organization' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.check_project_team_scope() from public, anon, authenticated;
create trigger project_teams_check_scope before insert or update on public.project_teams
  for each row execute function private.check_project_team_scope();

-- Can a user see a project? Same rule as projects RLS (OWNER/ADMIN or member of its team) plus collaborating teams.
create or replace function private.user_can_see_project(p_user_id uuid, p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects p
    join public.teams t on t.id = p.team_id join public.departments d on d.id = t.department_id
    where p.id = p_project_id and (
      exists (select 1 from public.organization_members m
              where m.organization_id = d.organization_id and m.user_id = p_user_id and m.role in ('OWNER', 'ADMIN'))
      or (exists (select 1 from public.organization_members m where m.organization_id = d.organization_id and m.user_id = p_user_id)
          and (exists (select 1 from public.team_members tm where tm.team_id = t.id and tm.user_id = p_user_id)
               or exists (select 1 from public.project_teams pt join public.team_members tm on tm.team_id = pt.team_id
                          where pt.project_id = p.id and tm.user_id = p_user_id)))
    )
  );
$$;
revoke all on function private.user_can_see_project(uuid, uuid) from public, anon, authenticated;

create or replace function public.is_project_collaborator(p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.project_teams pt join public.team_members tm on tm.team_id = pt.team_id
    where pt.project_id = p_project_id and tm.user_id = (select auth.uid())
      and public.is_org_member(private.project_org(p_project_id))
  );
$$;
revoke all on function public.is_project_collaborator(uuid) from public, anon;
grant execute on function public.is_project_collaborator(uuid) to authenticated;

-- Additional permissive policy: the existing projects_select_admin_or_team_member policy is unchanged.
create policy "projects_select_collaborating_team" on public.projects for select to authenticated
  using (public.is_project_collaborator(id));

alter table public.project_teams enable row level security;
create policy "project_teams_select" on public.project_teams for select to authenticated
  using (exists (select 1 from public.projects p where p.id = project_teams.project_id));
revoke all on public.project_teams from anon, authenticated;
grant select on public.project_teams to authenticated;

-- 1. Tasks: planning fields, assignee, responsible team, extended lifecycle --------------------------------------
alter table public.tasks
  add column assignee_id         uuid references auth.users (id) on delete set null,
  add column assigned_by         uuid references auth.users (id) on delete set null,
  add column assigned_at         timestamptz,
  add column team_id             uuid references public.teams (id) on delete set null,
  add column acceptance_criteria text check (char_length(acceptance_criteria) <= 4000),
  add column estimated_hours     numeric(6, 1) check (estimated_hours > 0 and estimated_hours <= 1000),
  add column due_date            date;

create index tasks_assignee_idx on public.tasks (assignee_id) where assignee_id is not null;
create index tasks_team_idx on public.tasks (team_id) where team_id is not null;

alter table public.tasks drop constraint if exists tasks_status_check;
alter table public.tasks add constraint tasks_status_check
  check (status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED'));

-- Lifecycle (who may do which step is decided by transition_task()):
--   TODO -> IN_PROGRESS | CANCELLED
--   IN_PROGRESS -> BLOCKED | IN_REVIEW | COMPLETED | TODO | CANCELLED
--   BLOCKED -> IN_PROGRESS | CANCELLED
--   IN_REVIEW -> COMPLETED (approved) | IN_PROGRESS (changes requested) | CANCELLED
--   COMPLETED -> IN_PROGRESS (reopen);  CANCELLED -> TODO
create or replace function public.enforce_task_status_transition()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if not (
    (old.status = 'TODO'        and new.status in ('IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'IN_PROGRESS' and new.status in ('BLOCKED', 'IN_REVIEW', 'COMPLETED', 'TODO', 'CANCELLED')) or
    (old.status = 'BLOCKED'     and new.status in ('IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'IN_REVIEW'   and new.status in ('COMPLETED', 'IN_PROGRESS', 'CANCELLED')) or
    (old.status = 'COMPLETED'   and new.status = 'IN_PROGRESS') or
    (old.status = 'CANCELLED'   and new.status = 'TODO')
  ) then
    raise exception 'Invalid task status transition: % -> %', old.status, new.status using errcode = '23514';
  end if;
  return new;
end;
$$;

-- The responsible team must be the project's team or a collaborating team.
create or replace function private.check_task_team_scope()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_project uuid;
begin
  if new.team_id is null then return new; end if;
  select r.project_id into v_project from public.requirements r where r.id = new.requirement_id;
  if not exists (select 1 from public.projects p where p.id = v_project and p.team_id = new.team_id)
     and not exists (select 1 from public.project_teams pt where pt.project_id = v_project and pt.team_id = new.team_id) then
    raise exception 'The team does not work on this project' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function private.check_task_team_scope() from public, anon, authenticated;
create trigger tasks_check_team_scope before insert or update of team_id on public.tasks
  for each row execute function private.check_task_team_scope();

-- Clients keep updating title/description/priority and the new planning fields (tasks_update_admin policy:
-- OWNER/ADMIN); status, assignee and responsible team change only through the functions below.
revoke update on public.tasks from authenticated;
grant update (title, description, priority, acceptance_criteria, estimated_hours, due_date) on public.tasks to authenticated;

-- 2. Required skills and dependencies ----------------------------------------------------------------------------
create table public.task_required_skills (
  task_id  uuid not null references public.tasks (id) on delete cascade,
  skill_id uuid not null references public.skills (id) on delete cascade,
  primary key (task_id, skill_id)
);
create index task_required_skills_skill_idx on public.task_required_skills (skill_id);

create table public.task_dependencies (
  task_id            uuid not null references public.tasks (id) on delete cascade,
  depends_on_task_id uuid not null references public.tasks (id) on delete cascade,
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  primary key (task_id, depends_on_task_id),
  constraint task_dependencies_not_self check (task_id <> depends_on_task_id)
);
create index task_dependencies_depends_on_idx on public.task_dependencies (depends_on_task_id);

-- 3. Activity, comments, handoffs, notifications, settings -------------------------------------------------------
create table public.task_events (
  id          bigint generated always as identity primary key,
  task_id     uuid not null references public.tasks (id) on delete cascade,
  actor_id    uuid references auth.users (id) on delete set null,
  event_type  text not null check (event_type in ('CREATED', 'STATUS_CHANGED', 'ASSIGNED', 'UNASSIGNED', 'COMMENTED',
                'DEPENDENCY_ADDED', 'DEPENDENCY_REMOVED', 'SKILLS_CHANGED', 'HANDOFF_CREATED', 'HANDOFF_ACCEPTED',
                'HANDOFF_DECLINED', 'HANDOFF_CANCELLED')),
  from_status text,
  to_status   text,
  details     jsonb not null default '{}'::jsonb check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096),
  created_at  timestamptz not null default now()
);
create index task_events_task_idx on public.task_events (task_id, id);

create table public.task_comments (
  id         uuid primary key default gen_random_uuid(),
  task_id    uuid not null references public.tasks (id) on delete cascade,
  author_id  uuid references auth.users (id) on delete set null,
  body       text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index task_comments_task_idx on public.task_comments (task_id, created_at);

create table public.task_handoffs (
  id             uuid primary key default gen_random_uuid(),
  task_id        uuid not null references public.tasks (id) on delete cascade,
  from_team_id   uuid references public.teams (id) on delete set null,
  to_team_id     uuid not null references public.teams (id) on delete cascade,
  summary        text not null check (char_length(btrim(summary)) between 1 and 4000),
  remaining_work text check (char_length(remaining_work) <= 4000),
  notes          text check (char_length(notes) <= 4000),
  status         text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'DECLINED', 'CANCELLED')),
  created_by     uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  responded_by   uuid references auth.users (id) on delete set null,
  responded_at   timestamptz,
  response_note  text check (char_length(response_note) <= 2000),
  constraint task_handoffs_responded check ((status = 'PENDING') = (responded_at is null))
);
create unique index task_handoffs_pending_key on public.task_handoffs (task_id) where status = 'PENDING';
create index task_handoffs_to_team_idx on public.task_handoffs (to_team_id, status);

create table public.notifications (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  type            text not null check (type ~ '^[a-z]+(\.[a-z_]+)+$' and char_length(type) <= 64),
  task_id         uuid references public.tasks (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 200),
  body            text check (char_length(body) <= 1000),
  link            text check (link ~ '^/[A-Za-z0-9/_-]*$' and char_length(link) <= 400),
  dedupe_key      text not null check (char_length(dedupe_key) <= 200),
  created_at      timestamptz not null default now(),
  read_at         timestamptz,
  constraint notifications_dedupe_key unique (user_id, dedupe_key)
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.organization_settings (
  organization_id uuid primary key references public.organizations (id) on delete cascade,
  assignment_mode text not null default 'MANUAL' check (assignment_mode in ('MANUAL', 'RECOMMEND', 'AUTO')),
  updated_by      uuid references auth.users (id) on delete set null,
  updated_at      timestamptz not null default now()
);

-- RLS: reads follow task visibility (tasks RLS -> project visibility); no client writes except comments.
alter table public.task_required_skills enable row level security;
alter table public.task_dependencies enable row level security;
alter table public.task_events enable row level security;
alter table public.task_comments enable row level security;
alter table public.task_handoffs enable row level security;
alter table public.notifications enable row level security;
alter table public.organization_settings enable row level security;

create policy "task_required_skills_select" on public.task_required_skills for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_required_skills.task_id));
create policy "task_dependencies_select" on public.task_dependencies for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_dependencies.task_id));
create policy "task_events_select" on public.task_events for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_events.task_id));
create policy "task_comments_select" on public.task_comments for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_comments.task_id));
create policy "task_handoffs_select" on public.task_handoffs for select to authenticated
  using (exists (select 1 from public.tasks k where k.id = task_handoffs.task_id)
         or exists (select 1 from public.team_members tm where tm.team_id = task_handoffs.to_team_id and tm.user_id = (select auth.uid())));
create policy "notifications_select_own" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));
create policy "organization_settings_select_member" on public.organization_settings for select to authenticated
  using (public.is_org_member(organization_id));

revoke all on public.task_required_skills, public.task_dependencies, public.task_events, public.task_comments,
  public.task_handoffs, public.notifications, public.organization_settings from anon, authenticated;
grant select on public.task_required_skills, public.task_dependencies, public.task_events, public.task_comments,
  public.task_handoffs, public.notifications, public.organization_settings to authenticated;

-- 4. Internal helpers --------------------------------------------------------------------------------------------
create or replace function private.task_org(p_task_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select private.project_org(private.task_project(p_task_id));
$$;

-- App path of a task (used for notification links).
create or replace function private.task_link(p_task_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select '/organizations/' || d.organization_id || '/departments/' || d.id || '/teams/' || t.id || '/projects/' || p.id
         || '/requirements/' || r.id || '/tasks/' || k.id
  from public.tasks k join public.requirements r on r.id = k.requirement_id join public.projects p on p.id = r.project_id
  join public.teams t on t.id = p.team_id join public.departments d on d.id = t.department_id
  where k.id = p_task_id;
$$;

create or replace function private.log_task_event(p_task_id uuid, p_type text, p_from text, p_to text, p_details jsonb)
returns bigint language sql security definer set search_path = '' as $$
  insert into public.task_events (task_id, actor_id, event_type, from_status, to_status, details)
  values (p_task_id, (select auth.uid()), p_type, p_from, p_to, coalesce(p_details, '{}'::jsonb))
  returning id;
$$;

-- In-app notification for one user about one task. Skips the actor themselves and anyone who cannot see the task's
-- project. Idempotent per (user, dedupe_key).
create or replace function private.notify_task(p_user_id uuid, p_task_id uuid, p_type text, p_title text, p_body text, p_dedupe text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_user_id = (select auth.uid()) then return; end if;
  if not private.user_can_see_project(p_user_id, private.task_project(p_task_id)) then return; end if;
  insert into public.notifications (user_id, organization_id, type, task_id, title, body, link, dedupe_key)
  values (p_user_id, private.task_org(p_task_id), p_type, p_task_id, left(p_title, 200), left(p_body, 1000),
          private.task_link(p_task_id), left(p_dedupe, 200))
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;

create or replace function private.require_task_manager(p_task_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.task_org(p_task_id);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_org is null or not public.has_org_role(v_org, array['OWNER', 'ADMIN']) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end;
$$;

-- Unfinished dependencies of a task (COMPLETED and CANCELLED count as done).
create or replace function private.open_dependencies(p_task_id uuid)
returns int language sql stable security definer set search_path = '' as $$
  select count(*)::int from public.task_dependencies td join public.tasks k on k.id = td.depends_on_task_id
  where td.task_id = p_task_id and k.status not in ('COMPLETED', 'CANCELLED');
$$;

revoke all on function private.task_org(uuid) from public, anon, authenticated;
revoke all on function private.task_link(uuid) from public, anon, authenticated;
revoke all on function private.log_task_event(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function private.notify_task(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke all on function private.require_task_manager(uuid) from public, anon, authenticated;
revoke all on function private.open_dependencies(uuid) from public, anon, authenticated;

-- 'CREATED' event for every new task.
create or replace function private.log_task_created()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.task_events (task_id, actor_id, event_type, to_status) values (new.id, new.created_by, 'CREATED', new.status);
  return new;
end;
$$;
revoke all on function private.log_task_created() from public, anon, authenticated;
create trigger tasks_log_created after insert on public.tasks for each row execute function private.log_task_created();

-- A member who leaves an organization is unassigned from its tasks.
create or replace function private.unassign_tasks_on_leave()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.tasks k set assignee_id = null, assigned_at = null, assigned_by = null,
         status = case when k.status = 'IN_PROGRESS' then 'TODO' else k.status end
  where k.assignee_id = old.user_id and private.task_org(k.id) = old.organization_id;
  return old;
end;
$$;
revoke all on function private.unassign_tasks_on_leave() from public, anon, authenticated;
create trigger organization_members_unassign_tasks after delete on public.organization_members
  for each row execute function private.unassign_tasks_on_leave();

-- 5. Assignment --------------------------------------------------------------------------------------------------
-- Assign (or with p_assignee NULL, unassign) a task. Compare-and-set on the current assignee: p_expected_assignee
-- must equal the assignee the caller saw, otherwise 40001 is raised and nothing changes (concurrent assignment).
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
  if v_task.status in ('COMPLETED', 'CANCELLED', 'IN_REVIEW') then
    raise exception 'A % task cannot be reassigned', v_task.status using errcode = '55000';
  end if;
  if p_assignee is not distinct from v_task.assignee_id then return; end if;

  v_org := private.task_org(p_task_id);
  if p_assignee is not null then
    if not exists (select 1 from public.organization_members m where m.organization_id = v_org and m.user_id = p_assignee) then
      raise exception 'The assignee is not a member of this organization' using errcode = '42501';
    end if;
    if not private.user_can_see_project(p_assignee, private.task_project(p_task_id)) then
      raise exception 'The assignee has no access to this project (not in its team or a collaborating team)' using errcode = '23514';
    end if;
    select w.availability into v_avail from public.workforce_profiles w where w.organization_id = v_org and w.user_id = p_assignee;
    if v_avail = 'UNAVAILABLE' then
      raise exception 'The assignee is marked unavailable' using errcode = '23514';
    end if;
  end if;

  -- Assigned is not in progress: a reassigned task in progress goes back to TODO for the new person.
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

-- Eligible people for a task, with the facts used for ranking (src/lib/workforce/assignment.ts ranks them).
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
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW') and private.task_org(k2.id) = v_org),
           (select coalesce(sum(k2.estimated_hours), 0) from public.tasks k2 where k2.assignee_id = m.user_id
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW') and private.task_org(k2.id) = v_org),
           (select count(*)::int from public.tasks k2 where k2.assignee_id = m.user_id and k2.estimated_hours is null
              and k2.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW') and private.task_org(k2.id) = v_org)
    from public.organization_members m
    join public.profiles pr on pr.id = m.user_id
    left join public.workforce_profiles w on w.organization_id = v_org and w.user_id = m.user_id
    where m.organization_id = v_org and private.user_can_see_project(m.user_id, v_project)
    order by m.user_id;
end;
$$;

-- Workload per member of an organization (OWNER/ADMIN). Active = TODO, IN_PROGRESS, BLOCKED, IN_REVIEW.
create or replace function public.organization_workload(p_organization_id uuid)
returns table (user_id uuid, active_tasks int, in_progress int, blocked int, in_review int, active_hours numeric, unestimated_tasks int, overdue int)
language plpgsql stable security definer set search_path = '' as $$
#variable_conflict use_column
begin
  perform private.require_org_manager(p_organization_id);
  return query
    select m.user_id,
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW'))::int,
           count(k.id) filter (where k.status = 'IN_PROGRESS')::int,
           count(k.id) filter (where k.status = 'BLOCKED')::int,
           count(k.id) filter (where k.status = 'IN_REVIEW')::int,
           coalesce(sum(k.estimated_hours) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW')), 0),
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW') and k.estimated_hours is null)::int,
           count(k.id) filter (where k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW') and k.due_date < current_date)::int
    from public.organization_members m
    left join public.tasks k on k.assignee_id = m.user_id and private.task_org(k.id) = p_organization_id
    where m.organization_id = p_organization_id
    group by m.user_id;
end;
$$;

create or replace function public.set_assignment_mode(p_organization_id uuid, p_mode text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if private.caller_org_role(p_organization_id) is distinct from 'OWNER' then
    raise exception 'Only an owner can change the assignment policy' using errcode = '42501';
  end if;
  if p_mode not in ('MANUAL', 'RECOMMEND', 'AUTO') then raise exception 'Invalid mode' using errcode = '22023'; end if;
  insert into public.organization_settings as s (organization_id, assignment_mode, updated_by, updated_at)
  values (p_organization_id, p_mode, (select auth.uid()), now())
  on conflict (organization_id) do update set assignment_mode = excluded.assignment_mode, updated_by = excluded.updated_by, updated_at = now();
  perform private.record_audit(p_organization_id, 'settings.assignment_mode', null, null, jsonb_build_object('mode', p_mode));
end;
$$;

create or replace function public.set_task_required_skills(p_task_id uuid, p_skill_ids uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  perform private.require_task_manager(p_task_id);
  v_org := private.task_org(p_task_id);
  if coalesce(array_length(p_skill_ids, 1), 0) > 20 then raise exception 'Too many skills' using errcode = '22023'; end if;
  if exists (select 1 from unnest(coalesce(p_skill_ids, '{}')) sid
             where not exists (select 1 from public.skills s where s.id = sid and s.organization_id = v_org)) then
    raise exception 'Unknown skill' using errcode = '22023';
  end if;
  delete from public.task_required_skills rs where rs.task_id = p_task_id and rs.skill_id <> all (coalesce(p_skill_ids, '{}'));
  insert into public.task_required_skills (task_id, skill_id) select p_task_id, sid from unnest(coalesce(p_skill_ids, '{}')) sid
  on conflict do nothing;
  perform private.log_task_event(p_task_id, 'SKILLS_CHANGED', null, null, jsonb_build_object('count', coalesce(array_length(p_skill_ids, 1), 0)));
end;
$$;

-- 6. Status workflow ---------------------------------------------------------------------------------------------
create or replace function public.transition_task(p_task_id uuid, p_status text, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_task     public.tasks;
  v_user     uuid := (select auth.uid());
  v_manager  boolean;
  v_assignee boolean;
  v_reason   text := nullif(btrim(p_reason), '');
  v_event    bigint;
  r          record;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.id is null or not private.user_can_see_project(v_user, private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_status not in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'COMPLETED', 'CANCELLED') then
    raise exception 'Invalid status' using errcode = '22023';
  end if;
  if p_status = v_task.status then return; end if;
  v_manager := public.has_org_role(private.task_org(p_task_id), array['OWNER', 'ADMIN']);
  v_assignee := v_task.assignee_id = v_user;

  -- Who may take which step. Managers review, cancel, reopen and complete; the assignee does the work.
  if not v_manager and not (v_assignee and (
       (v_task.status = 'TODO' and p_status = 'IN_PROGRESS') or
       (v_task.status = 'IN_PROGRESS' and p_status in ('BLOCKED', 'IN_REVIEW', 'TODO')) or
       (v_task.status = 'BLOCKED' and p_status = 'IN_PROGRESS')
     )) then
    raise exception 'You cannot move this task from % to %', v_task.status, p_status using errcode = '42501';
  end if;
  if p_status in ('BLOCKED', 'CANCELLED') and v_reason is null then
    raise exception 'A reason is required' using errcode = '22023';
  end if;
  if v_task.status = 'IN_REVIEW' and p_status = 'IN_PROGRESS' and v_reason is null then
    raise exception 'Describe the requested changes' using errcode = '22023';
  end if;
  if p_status = 'IN_PROGRESS' and v_task.status = 'TODO' and v_task.assignee_id is null then
    raise exception 'Assign the task before starting it' using errcode = '55000';
  end if;
  if p_status in ('IN_PROGRESS', 'IN_REVIEW', 'COMPLETED') and private.open_dependencies(p_task_id) > 0 then
    raise exception 'Waiting for % unfinished dependenc%', private.open_dependencies(p_task_id),
      case when private.open_dependencies(p_task_id) = 1 then 'y' else 'ies' end using errcode = '55000';
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
  elsif v_task.status = 'IN_REVIEW' and p_status = 'IN_PROGRESS' then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.changes_requested', 'Changes requested: ' || v_task.title, v_reason, 'task.changes:' || v_event);
  elsif p_status = 'COMPLETED' then
    perform private.notify_task(v_task.assignee_id, p_task_id, 'task.completed', 'Completed: ' || v_task.title, null, 'task.completed:' || v_event);
    -- Tasks waiting on this one: tell their assignees when nothing else is open.
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

-- 7. Dependencies ------------------------------------------------------------------------------------------------
create or replace function public.add_task_dependency(p_task_id uuid, p_depends_on uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_task_manager(p_task_id);
  if p_task_id = p_depends_on then raise exception 'A task cannot depend on itself' using errcode = '23514'; end if;
  if private.task_project(p_depends_on) is distinct from private.task_project(p_task_id) then
    raise exception 'Dependencies must be in the same project' using errcode = '23514';
  end if;
  -- Refuse cycles: p_depends_on must not (transitively) depend on p_task_id.
  if exists (
    with recursive chain(id) as (
      select td.depends_on_task_id from public.task_dependencies td where td.task_id = p_depends_on
      union
      select td.depends_on_task_id from public.task_dependencies td join chain c on td.task_id = c.id
    )
    select 1 from chain where id = p_task_id
  ) or (select count(*) from public.task_dependencies td where td.task_id = p_task_id) >= 50 then
    raise exception 'That dependency would create a cycle' using errcode = '23514';
  end if;
  insert into public.task_dependencies (task_id, depends_on_task_id, created_by) values (p_task_id, p_depends_on, (select auth.uid()))
  on conflict do nothing;
  perform private.log_task_event(p_task_id, 'DEPENDENCY_ADDED', null, null, jsonb_build_object('depends_on', p_depends_on));
end;
$$;

create or replace function public.remove_task_dependency(p_task_id uuid, p_depends_on uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.require_task_manager(p_task_id);
  delete from public.task_dependencies td where td.task_id = p_task_id and td.depends_on_task_id = p_depends_on;
  if found then
    perform private.log_task_event(p_task_id, 'DEPENDENCY_REMOVED', null, null, jsonb_build_object('depends_on', p_depends_on));
  end if;
end;
$$;

-- 8. Comments ----------------------------------------------------------------------------------------------------
create or replace function public.add_task_comment(p_task_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_task public.tasks;
  v_id   uuid;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id;
  if v_task.id is null or not private.user_can_see_project(v_user, private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_body is null or char_length(btrim(p_body)) not between 1 and 4000 then
    raise exception 'A comment must be 1-4000 characters' using errcode = '22023';
  end if;
  insert into public.task_comments (task_id, author_id, body) values (p_task_id, v_user, btrim(p_body)) returning id into v_id;
  perform private.log_task_event(p_task_id, 'COMMENTED', null, null, jsonb_build_object('comment_id', v_id));
  perform private.notify_task(v_task.assignee_id, p_task_id, 'task.commented', 'New comment: ' || v_task.title, left(btrim(p_body), 300), 'task.comment:' || v_id);
  return v_id;
end;
$$;

-- 9. Collaborating teams and handoffs ----------------------------------------------------------------------------
create or replace function public.add_project_team(p_project_id uuid, p_team_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.project_org(p_project_id);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_org is null or not public.has_org_role(v_org, array['OWNER', 'ADMIN']) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.projects p where p.id = p_project_id and p.team_id = p_team_id) then return; end if;
  insert into public.project_teams (project_id, team_id, added_by) values (p_project_id, p_team_id, (select auth.uid()))
  on conflict do nothing;
  perform private.record_audit(v_org, 'project.team_added', null, null, jsonb_build_object('project_id', p_project_id, 'team_id', p_team_id));
end;
$$;

create or replace function public.remove_project_team(p_project_id uuid, p_team_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_org uuid := private.project_org(p_project_id);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_org is null or not public.has_org_role(v_org, array['OWNER', 'ADMIN']) then raise exception 'Not allowed' using errcode = '42501'; end if;
  if exists (select 1 from public.tasks k join public.requirements r on r.id = k.requirement_id
             where r.project_id = p_project_id and k.team_id = p_team_id and k.status not in ('COMPLETED', 'CANCELLED')) then
    raise exception 'The team still owns open tasks of this project' using errcode = '55000';
  end if;
  delete from public.project_teams pt where pt.project_id = p_project_id and pt.team_id = p_team_id;
  perform private.record_audit(v_org, 'project.team_removed', null, null, jsonb_build_object('project_id', p_project_id, 'team_id', p_team_id));
end;
$$;

-- Hand a task to another team working on the project (its own team or a collaborating team). The assignee or a
-- manager; the receiving team's members are notified. One pending handoff per task.
create or replace function public.create_task_handoff(p_task_id uuid, p_to_team_id uuid, p_summary text, p_remaining text, p_notes text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_task public.tasks;
  v_project uuid;
  v_from uuid;
  v_id uuid;
  r record;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_task from public.tasks k where k.id = p_task_id for update;
  if v_task.id is null or not private.user_can_see_project(v_user, private.task_project(p_task_id)) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if not (v_task.assignee_id = v_user or public.has_org_role(private.task_org(p_task_id), array['OWNER', 'ADMIN'])) then
    raise exception 'Only the assignee or an admin can hand off this task' using errcode = '42501';
  end if;
  if v_task.status = 'CANCELLED' then raise exception 'A cancelled task cannot be handed off' using errcode = '55000'; end if;
  if p_summary is null or char_length(btrim(p_summary)) not between 1 and 4000 then
    raise exception 'Describe the work completed (1-4000 characters)' using errcode = '22023';
  end if;
  v_project := private.task_project(p_task_id);
  select coalesce(v_task.team_id, p.team_id) into v_from from public.projects p where p.id = v_project;
  if p_to_team_id = v_from then raise exception 'The task already belongs to that team' using errcode = '22023'; end if;
  if not exists (select 1 from public.projects p where p.id = v_project and p.team_id = p_to_team_id)
     and not exists (select 1 from public.project_teams pt where pt.project_id = v_project and pt.team_id = p_to_team_id) then
    raise exception 'That team does not work on this project; add it as a collaborating team first' using errcode = '23514';
  end if;
  if exists (select 1 from public.task_handoffs h where h.task_id = p_task_id and h.status = 'PENDING') then
    raise exception 'A handoff for this task is already pending' using errcode = '23505';
  end if;
  insert into public.task_handoffs (task_id, from_team_id, to_team_id, summary, remaining_work, notes, created_by)
  values (p_task_id, v_from, p_to_team_id, btrim(p_summary), nullif(btrim(p_remaining), ''), nullif(btrim(p_notes), ''), v_user)
  returning id into v_id;
  perform private.log_task_event(p_task_id, 'HANDOFF_CREATED', null, null, jsonb_build_object('handoff_id', v_id, 'to_team', p_to_team_id));
  for r in select tm.user_id from public.team_members tm where tm.team_id = p_to_team_id limit 200 loop
    perform private.notify_task(r.user_id, p_task_id, 'task.handoff', 'Handoff to your team: ' || v_task.title, left(btrim(p_summary), 300), 'task.handoff:' || v_id);
  end loop;
  return v_id;
end;
$$;

-- Accept or decline a handoff: a member of the receiving team or a manager. Accepting makes the receiving team
-- responsible; with p_take the accepting person also becomes the assignee (same eligibility as assign_task).
-- The creator (or a manager) may cancel a pending handoff with p_accept NULL.
create or replace function public.respond_task_handoff(p_handoff_id uuid, p_accept boolean, p_note text, p_take boolean default false)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_h    public.task_handoffs;
  v_task public.tasks;
  v_manager boolean;
  v_receiver boolean;
  v_event bigint;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_h from public.task_handoffs h where h.id = p_handoff_id for update;
  if v_h.id is null then raise exception 'Not allowed' using errcode = '42501'; end if;
  select * into v_task from public.tasks k where k.id = v_h.task_id for update;
  v_manager := public.has_org_role(private.task_org(v_task.id), array['OWNER', 'ADMIN']);
  v_receiver := exists (select 1 from public.team_members tm where tm.team_id = v_h.to_team_id and tm.user_id = v_user)
                and public.is_org_member(private.task_org(v_task.id));
  if v_h.status <> 'PENDING' then raise exception 'The handoff is no longer pending' using errcode = '55000'; end if;

  if p_accept is null then
    if not (v_manager or v_h.created_by = v_user) then raise exception 'Not allowed' using errcode = '42501'; end if;
    update public.task_handoffs h set status = 'CANCELLED', responded_by = v_user, responded_at = now(), response_note = left(nullif(btrim(p_note), ''), 2000)
    where h.id = v_h.id;
    perform private.log_task_event(v_task.id, 'HANDOFF_CANCELLED', null, null, jsonb_build_object('handoff_id', v_h.id));
    return;
  end if;
  if not (v_manager or v_receiver) then raise exception 'Not allowed' using errcode = '42501'; end if;

  update public.task_handoffs h set status = case when p_accept then 'ACCEPTED' else 'DECLINED' end,
         responded_by = v_user, responded_at = now(), response_note = left(nullif(btrim(p_note), ''), 2000)
  where h.id = v_h.id;
  if p_accept then
    update public.tasks k set team_id = v_h.to_team_id where k.id = v_task.id;
    v_event := private.log_task_event(v_task.id, 'HANDOFF_ACCEPTED', null, null, jsonb_build_object('handoff_id', v_h.id, 'to_team', v_h.to_team_id));
    if p_take and v_task.status not in ('COMPLETED', 'CANCELLED', 'IN_REVIEW') and v_task.assignee_id is distinct from v_user then
      if exists (select 1 from public.workforce_profiles w where w.organization_id = private.task_org(v_task.id) and w.user_id = v_user and w.availability = 'UNAVAILABLE') then
        raise exception 'You are marked unavailable' using errcode = '23514';
      end if;
      update public.tasks k set assignee_id = v_user, assigned_by = v_user, assigned_at = now(),
             status = case when k.status = 'IN_PROGRESS' then 'TODO' else k.status end
      where k.id = v_task.id;
      perform private.log_task_event(v_task.id, 'ASSIGNED', null, null, jsonb_build_object('from', v_task.assignee_id, 'to', v_user, 'mode', 'HANDOFF'));
      perform private.notify_task(v_task.assignee_id, v_task.id, 'task.unassigned', 'Handed off: ' || v_task.title, 'The receiving team took over this task.', 'task.unassigned:' || v_event);
    end if;
    perform private.notify_task(v_h.created_by, v_task.id, 'task.handoff_accepted', 'Handoff accepted: ' || v_task.title, left(nullif(btrim(p_note), ''), 300), 'task.handoff_accepted:' || v_h.id);
  else
    perform private.log_task_event(v_task.id, 'HANDOFF_DECLINED', null, null, jsonb_build_object('handoff_id', v_h.id, 'reason', left(nullif(btrim(p_note), ''), 500)));
    perform private.notify_task(v_h.created_by, v_task.id, 'task.handoff_declined', 'Handoff declined: ' || v_task.title, left(nullif(btrim(p_note), ''), 300), 'task.handoff_declined:' || v_h.id);
  end if;
end;
$$;

-- 10. Notifications: mark as read (own only) -----------------------------------------------------------------------
create or replace function public.mark_notifications_read(p_ids uuid[])
returns int language plpgsql security definer set search_path = '' as $$
declare v_n int;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  update public.notifications n set read_at = now()
  where n.user_id = (select auth.uid()) and n.read_at is null and (p_ids is null or n.id = any (p_ids));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 11. Privileges -------------------------------------------------------------------------------------------------
revoke all on function public.assign_task(uuid, uuid, uuid, text, text) from public, anon;
revoke all on function public.task_assignment_candidates(uuid) from public, anon;
revoke all on function public.organization_workload(uuid) from public, anon;
revoke all on function public.set_assignment_mode(uuid, text) from public, anon;
revoke all on function public.set_task_required_skills(uuid, uuid[]) from public, anon;
revoke all on function public.transition_task(uuid, text, text) from public, anon;
revoke all on function public.add_task_dependency(uuid, uuid) from public, anon;
revoke all on function public.remove_task_dependency(uuid, uuid) from public, anon;
revoke all on function public.add_task_comment(uuid, text) from public, anon;
revoke all on function public.add_project_team(uuid, uuid) from public, anon;
revoke all on function public.remove_project_team(uuid, uuid) from public, anon;
revoke all on function public.create_task_handoff(uuid, uuid, text, text, text) from public, anon;
revoke all on function public.respond_task_handoff(uuid, boolean, text, boolean) from public, anon;
revoke all on function public.mark_notifications_read(uuid[]) from public, anon;
grant execute on function public.assign_task(uuid, uuid, uuid, text, text) to authenticated;
grant execute on function public.task_assignment_candidates(uuid) to authenticated;
grant execute on function public.organization_workload(uuid) to authenticated;
grant execute on function public.set_assignment_mode(uuid, text) to authenticated;
grant execute on function public.set_task_required_skills(uuid, uuid[]) to authenticated;
grant execute on function public.transition_task(uuid, text, text) to authenticated;
grant execute on function public.add_task_dependency(uuid, uuid) to authenticated;
grant execute on function public.remove_task_dependency(uuid, uuid) to authenticated;
grant execute on function public.add_task_comment(uuid, text) to authenticated;
grant execute on function public.add_project_team(uuid, uuid) to authenticated;
grant execute on function public.remove_project_team(uuid, uuid) to authenticated;
grant execute on function public.create_task_handoff(uuid, uuid, text, text, text) to authenticated;
grant execute on function public.respond_task_handoff(uuid, boolean, text, boolean) to authenticated;
grant execute on function public.mark_notifications_read(uuid[]) to authenticated;
