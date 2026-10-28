-- Bug assignment: manual and automatic assignment to eligible people, assignment history, comments and notifications.
--
-- Everything here is a SECURITY DEFINER function with its own authorization. Eligibility is decided HERE, not by the
-- caller: an assignee must be an active member of the organization who can see the bug's project and is not marked
-- UNAVAILABLE in the workforce directory. Automatic assignment ranks candidates in the application (skills, team,
-- workload) but the database re-checks the chosen person with the same rule as a manual assignment.

-- Link to the bug page, used by notifications. Internal.
create or replace function private.bug_link(p_bug_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select '/organizations/' || d.organization_id || '/departments/' || d.id || '/teams/' || t.id || '/projects/' || p.id || '/bugs/' || b.id
  from public.repository_bugs b
  join public.projects p on p.id = b.project_id
  join public.teams t on t.id = p.team_id
  join public.departments d on d.id = t.department_id
  where b.id = p_bug_id;
$$;
revoke all on function private.bug_link(uuid) from public, anon, authenticated;

create or replace function private.bug_assignee_eligible(p_project_id uuid, p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.organization_members m
    where m.user_id = p_user_id and m.status = 'ACTIVE' and m.organization_id = private.project_org(p_project_id)
  )
  and private.user_can_see_project(p_user_id, p_project_id)
  and not exists (
    select 1 from public.workforce_profiles w
    where w.user_id = p_user_id and w.organization_id = private.project_org(p_project_id) and w.availability = 'UNAVAILABLE'
  );
$$;
revoke all on function private.bug_assignee_eligible(uuid, uuid) from public, anon, authenticated;

-- Loads and locks a bug for a caller who must be OWNER/ADMIN of its organization (42501 otherwise).
create or replace function private.lock_bug_for_admin(p_bug_id uuid)
returns public.repository_bugs language plpgsql security definer set search_path = '' as $$
declare v_bug public.repository_bugs;
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_bug from public.repository_bugs b where b.id = p_bug_id for update;
  if v_bug.id is null or coalesce(private.caller_org_role(v_bug.organization_id), '') not in ('OWNER', 'ADMIN') then
    raise exception 'Bug not found' using errcode = '42501';
  end if;
  return v_bug;
end;
$$;
revoke all on function private.lock_bug_for_admin(uuid) from public, anon, authenticated;

-- Candidates the admin may assign to: eligible people with the facts the ranking needs. Admin only.
create or replace function public.list_bug_assignment_candidates(p_project_id uuid)
returns table (
  user_id uuid, display_name text, email text, role text, job_title text, availability text, team_id uuid,
  on_project_team boolean, skills text[], open_bugs integer, open_tasks integer
)
language plpgsql stable security definer set search_path = '' as $$
declare v_org uuid := private.project_org(p_project_id);
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  if v_org is null or coalesce(private.caller_org_role(v_org), '') not in ('OWNER', 'ADMIN') then raise exception 'Project not found' using errcode = '42501'; end if;
  return query
  select m.user_id,
         coalesce(nullif(btrim(w.full_name), ''), nullif(btrim(pr.display_name), ''), pr.email),
         pr.email, m.role, w.job_title, coalesce(w.availability, 'AVAILABLE'), w.team_id,
         exists (select 1 from public.projects p join public.team_members tm on tm.team_id = p.team_id where p.id = p_project_id and tm.user_id = m.user_id),
         coalesce((select array_agg(s.name order by s.name) from public.workforce_profile_skills ps join public.skills s on s.id = ps.skill_id where ps.profile_id = w.id), '{}'::text[]),
         (select count(*)::int from public.repository_bugs b where b.assigned_to = m.user_id and b.organization_id = v_org
            and b.status not in ('RESOLVED', 'REJECTED', 'CANCELLED')),
         (select count(*)::int from public.tasks k where k.assignee_id = m.user_id and k.status in ('TODO', 'IN_PROGRESS', 'BLOCKED', 'IN_REVIEW', 'IN_QA'))
  from public.organization_members m
  join public.profiles pr on pr.id = m.user_id
  left join public.workforce_profiles w on w.user_id = m.user_id and w.organization_id = v_org
  where m.organization_id = v_org and m.status = 'ACTIVE'
    and private.bug_assignee_eligible(p_project_id, m.user_id);
end;
$$;

create or replace function public.assign_bug(p_bug_id uuid, p_assignee uuid, p_source text, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_bug public.repository_bugs := private.lock_bug_for_admin(p_bug_id);
  v_prev uuid := v_bug.assigned_to;
  v_link text := private.bug_link(p_bug_id);
begin
  if p_source not in ('MANUAL', 'AUTO') then raise exception 'Invalid source' using errcode = '22023'; end if;
  if v_bug.status not in ('DETECTED', 'TRIAGED', 'REOPENED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED') then
    raise exception 'A bug in this stage cannot be reassigned' using errcode = '55000';
  end if;
  if p_assignee is null or not private.bug_assignee_eligible(v_bug.project_id, p_assignee) then
    raise exception 'That person cannot take this bug' using errcode = '22023';
  end if;
  if v_bug.status <> 'ASSIGNED' and not private.bug_transition_ok(v_bug.status, 'ASSIGNED') then
    raise exception 'A bug in this stage cannot be assigned' using errcode = '55000';
  end if;

  update public.repository_bugs b set status = 'ASSIGNED', assigned_to = p_assignee, assigned_by = (select auth.uid()), assigned_at = now(),
    assignment_source = p_source, assignment_reason = left(p_reason, 1000) where b.id = p_bug_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (p_bug_id, (select auth.uid()), 'assigned', v_bug.status, 'ASSIGNED',
          jsonb_build_object('assignee', p_assignee, 'previous_assignee', v_prev, 'source', p_source, 'reason', left(coalesce(p_reason, ''), 500)));
  perform private.notify_member(p_assignee, v_bug.organization_id, 'bug.assigned', 'Bug assigned to you: ' || left(v_bug.title, 120),
    case p_source when 'AUTO' then 'Automatically assigned. ' else '' end || left(coalesce(p_reason, ''), 600), v_link,
    'bug.assigned:' || p_bug_id || ':' || p_assignee || ':' || extract(epoch from clock_timestamp())::bigint);
  if v_prev is not null and v_prev <> p_assignee then
    perform private.notify_member(v_prev, v_bug.organization_id, 'bug.unassigned', 'Bug reassigned: ' || left(v_bug.title, 120), 'This bug was given to someone else.', v_link,
      'bug.unassigned:' || p_bug_id || ':' || v_prev || ':' || extract(epoch from clock_timestamp())::bigint);
  end if;
end;
$$;

create or replace function public.unassign_bug(p_bug_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bug public.repository_bugs := private.lock_bug_for_admin(p_bug_id);
begin
  if v_bug.status <> 'ASSIGNED' then raise exception 'Only a bug that has not been started can be unassigned' using errcode = '55000'; end if;
  update public.repository_bugs b set status = 'TRIAGED', assigned_to = null, assigned_by = null, assigned_at = null, assignment_source = null, assignment_reason = null where b.id = p_bug_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (p_bug_id, (select auth.uid()), 'unassigned', 'ASSIGNED', 'TRIAGED', jsonb_build_object('previous_assignee', v_bug.assigned_to, 'reason', left(coalesce(p_reason, ''), 500)));
  perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.unassigned', 'Bug unassigned: ' || left(v_bug.title, 120), 'You are no longer assigned to this bug.', private.bug_link(p_bug_id),
    'bug.unassigned:' || p_bug_id || ':' || v_bug.assigned_to || ':' || extract(epoch from clock_timestamp())::bigint);
end;
$$;

-- Status moves that need no fix evidence. The fix workflow stages (plan, approval, validation, review, QA, resolution)
-- are in the next migration; this function refuses them.
create or replace function public.transition_bug(p_bug_id uuid, p_to text, p_note text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := (select auth.uid());
  v_bug public.repository_bugs;
  v_admin boolean;
  v_note text := left(btrim(coalesce(p_note, '')), 1000);
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_bug from public.repository_bugs b where b.id = p_bug_id for update;
  if v_bug.id is null or not public.can_see_project(v_bug.project_id) then raise exception 'Bug not found' using errcode = '42501'; end if;
  v_admin := coalesce(private.caller_org_role(v_bug.organization_id), '') in ('OWNER', 'ADMIN');
  if not private.bug_transition_ok(v_bug.status, p_to) then raise exception 'That status change is not allowed' using errcode = '55000'; end if;

  if p_to in ('IN_PROGRESS', 'BLOCKED') then
    if not (v_admin or v_bug.assigned_to = v_user) then raise exception 'Only the assignee or an admin can do that' using errcode = '42501'; end if;
    if p_to = 'BLOCKED' and char_length(v_note) < 3 then raise exception 'Say what blocks it' using errcode = '22023'; end if;
  elsif p_to in ('TRIAGED', 'REJECTED', 'CANCELLED', 'REOPENED') then
    if not v_admin then raise exception 'Only an owner or admin can do that' using errcode = '42501'; end if;
    if p_to <> 'TRIAGED' and char_length(v_note) < 3 then raise exception 'A reason is required' using errcode = '22023'; end if;
  else
    raise exception 'Use the fix workflow for that stage' using errcode = '55000';
  end if;

  update public.repository_bugs b set status = p_to,
    assigned_to = case when p_to in ('TRIAGED', 'REJECTED', 'CANCELLED', 'REOPENED') then null else b.assigned_to end,
    assigned_at = case when p_to in ('TRIAGED', 'REJECTED', 'CANCELLED', 'REOPENED') then null else b.assigned_at end,
    assignment_source = case when p_to in ('TRIAGED', 'REJECTED', 'CANCELLED', 'REOPENED') then null else b.assignment_source end
  where b.id = p_bug_id;
  insert into public.repository_bug_events (bug_id, actor_id, type, from_status, to_status, details)
  values (p_bug_id, v_user, 'status_changed', v_bug.status, p_to, jsonb_build_object('note', v_note));
  if p_to = 'BLOCKED' then
    perform private.notify_member(m.user_id, v_bug.organization_id, 'bug.blocked', 'Bug blocked: ' || left(v_bug.title, 120), v_note, private.bug_link(p_bug_id),
      'bug.blocked:' || p_bug_id || ':' || m.user_id || ':' || extract(epoch from clock_timestamp())::bigint)
    from public.organization_members m where m.organization_id = v_bug.organization_id and m.role in ('OWNER', 'ADMIN') and m.status = 'ACTIVE';
  elsif v_bug.assigned_to is not null and v_bug.assigned_to <> v_user then
    perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.status', 'Bug moved to ' || lower(replace(p_to, '_', ' ')) || ': ' || left(v_bug.title, 100), v_note,
      private.bug_link(p_bug_id), 'bug.status:' || p_bug_id || ':' || p_to || ':' || extract(epoch from clock_timestamp())::bigint);
  end if;
end;
$$;

create or replace function public.add_bug_comment(p_bug_id uuid, p_body text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_bug public.repository_bugs; v_body text := btrim(coalesce(p_body, ''));
begin
  if (select auth.uid()) is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_bug from public.repository_bugs b where b.id = p_bug_id;
  if v_bug.id is null or not public.can_see_project(v_bug.project_id) then raise exception 'Bug not found' using errcode = '42501'; end if;
  if char_length(v_body) not between 1 and 2000 then raise exception 'Invalid comment' using errcode = '22023'; end if;
  insert into public.repository_bug_events (bug_id, actor_id, type, details) values (p_bug_id, (select auth.uid()), 'comment', jsonb_build_object('body', v_body));
  if v_bug.assigned_to is not null then
    perform private.notify_member(v_bug.assigned_to, v_bug.organization_id, 'bug.comment', 'New comment on: ' || left(v_bug.title, 120), left(v_body, 300), private.bug_link(p_bug_id),
      'bug.comment:' || p_bug_id || ':' || extract(epoch from clock_timestamp())::bigint);
  end if;
end;
$$;

revoke all on function public.list_bug_assignment_candidates(uuid) from public, anon;
revoke all on function public.assign_bug(uuid, uuid, text, text) from public, anon;
revoke all on function public.unassign_bug(uuid, text) from public, anon;
revoke all on function public.transition_bug(uuid, text, text) from public, anon;
revoke all on function public.add_bug_comment(uuid, text) from public, anon;
grant execute on function public.list_bug_assignment_candidates(uuid) to authenticated;
grant execute on function public.assign_bug(uuid, uuid, text, text) to authenticated;
grant execute on function public.unassign_bug(uuid, text) to authenticated;
grant execute on function public.transition_bug(uuid, text, text) to authenticated;
grant execute on function public.add_bug_comment(uuid, text) to authenticated;
