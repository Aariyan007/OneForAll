-- Phases 2-4 completion (2026-10-18): member suspension, invitation notifications and expiry, and the departments/teams
-- CSV import. Additive: one new column set on organization_members (every existing row stays ACTIVE), new functions,
-- and replaced function bodies with unchanged signatures (grants are kept by CREATE OR REPLACE).
--
-- Suspension is enforced where every access path already ends: is_org_member(), has_org_role(), caller_org_role(),
-- shares_organization() and user_can_see_project() now count ACTIVE memberships only. All RLS policies and SECURITY
-- DEFINER functions go through these helpers (directly, or through departments/teams/projects RLS), so a suspended
-- person loses access to the organization's data on their next request without any policy being rewritten.
-- Their membership row stays, so reactivation restores the same role.
--
-- Rollback: reactivate everyone (update organization_members set status = 'ACTIVE', suspended_at = null,
-- suspended_by = null), restore the previous helper bodies from 20261008000001 / 20261022000001 / 20261024000001,
-- then drop the new functions and columns. No data is lost by the forward migration.

-- 1. Suspension state ----------------------------------------------------------------------------------------------
alter table public.organization_members
  add column status       text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED')),
  add column suspended_at timestamptz,
  add column suspended_by uuid references auth.users (id) on delete set null,
  add constraint organization_members_suspended check ((status = 'SUSPENDED') = (suspended_at is not null));

-- Clients still have no write privilege on organization_members; the existing table-level SELECT grant covers the new
-- columns (rows remain limited by organization_members_select_member, i.e. active members of the organization).

create or replace function public.is_org_member(p_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'ACTIVE'
  );
$$;

create or replace function public.has_org_role(p_org_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = p_org_id
      and m.user_id = (select auth.uid())
      and m.status = 'ACTIVE'
      and m.role = any (p_roles)
  );
$$;

create or replace function private.caller_org_role(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.organization_members m
  where m.organization_id = p_organization_id and m.user_id = (select auth.uid()) and m.status = 'ACTIVE';
$$;

-- Co-member names: the caller must be an active member; a suspended co-member's name stays visible to the others.
create or replace function public.shares_organization(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members mine
    join public.organization_members theirs on theirs.organization_id = mine.organization_id
    where mine.user_id = (select auth.uid())
      and mine.status = 'ACTIVE'
      and theirs.user_id = p_user_id
  );
$$;

create or replace function private.user_can_see_project(p_user_id uuid, p_project_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.projects p
    join public.teams t on t.id = p.team_id join public.departments d on d.id = t.department_id
    where p.id = p_project_id and (
      exists (select 1 from public.organization_members m
              where m.organization_id = d.organization_id and m.user_id = p_user_id and m.status = 'ACTIVE'
                and m.role in ('OWNER', 'ADMIN'))
      or (exists (select 1 from public.organization_members m
                  where m.organization_id = d.organization_id and m.user_id = p_user_id and m.status = 'ACTIVE')
          and (exists (select 1 from public.team_members tm where tm.team_id = t.id and tm.user_id = p_user_id)
               or exists (select 1 from public.project_teams pt join public.team_members tm on tm.team_id = pt.team_id
                          where pt.project_id = p.id and tm.user_id = p_user_id)))
    )
  );
$$;

-- In-app notification about the organization (not about a task). Skips the actor and anyone who is not an active
-- member; idempotent per (user, dedupe_key). Internal.
create or replace function private.notify_member(
  p_user_id uuid, p_organization_id uuid, p_type text, p_title text, p_body text, p_link text, p_dedupe text
)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if p_user_id is null or p_user_id = (select auth.uid()) then return; end if;
  if not exists (select 1 from public.organization_members m
                 where m.organization_id = p_organization_id and m.user_id = p_user_id and m.status = 'ACTIVE') then
    return;
  end if;
  insert into public.notifications (user_id, organization_id, type, title, body, link, dedupe_key)
  values (p_user_id, p_organization_id, p_type, left(p_title, 200), left(p_body, 1000), p_link, left(p_dedupe, 200))
  on conflict (user_id, dedupe_key) do nothing;
end;
$$;
revoke all on function private.notify_member(uuid, uuid, text, text, text, text, text) from public, anon, authenticated;

create or replace function private.member_label(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(btrim(p.display_name), ''), p.email, 'Someone') from public.profiles p where p.id = p_user_id;
$$;
revoke all on function private.member_label(uuid) from public, anon, authenticated;

-- Suspend: an OWNER suspends admins and employees, an ADMIN suspends employees; never an owner, never oneself.
-- The person's open tasks in this organization are unassigned (they can no longer work on them) and logged.
create or replace function public.suspend_organization_member(p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := (select auth.uid());
  v_target public.organization_members;
  v_role   text;
  r        record;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_target from public.organization_members m where m.id = p_member_id for update;
  v_role := case when v_target.id is null then null else private.caller_org_role(v_target.organization_id) end;
  if v_role is null or v_role not in ('OWNER', 'ADMIN') then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_target.user_id = v_user then raise exception 'You cannot suspend yourself' using errcode = '42501'; end if;
  if v_target.role = 'OWNER' then raise exception 'An owner cannot be suspended' using errcode = '42501'; end if;
  if v_role = 'ADMIN' and v_target.role <> 'MEMBER' then raise exception 'Admins can suspend employees only' using errcode = '42501'; end if;
  if v_target.status = 'SUSPENDED' then return; end if;

  update public.organization_members m set status = 'SUSPENDED', suspended_at = now(), suspended_by = v_user
  where m.id = v_target.id;

  for r in select k.id, k.status from public.tasks k
           where k.assignee_id = v_target.user_id and private.task_org(k.id) = v_target.organization_id
             and k.status not in ('COMPLETED', 'CANCELLED')
           for update loop
    update public.tasks k set assignee_id = null, assigned_by = null, assigned_at = null,
           status = case when k.status = 'IN_PROGRESS' then 'TODO' else k.status end
    where k.id = r.id;
    perform private.log_task_event(r.id, 'UNASSIGNED',
      case when r.status = 'IN_PROGRESS' then 'IN_PROGRESS' end, case when r.status = 'IN_PROGRESS' then 'TODO' end,
      jsonb_build_object('from', v_target.user_id, 'reason', 'member suspended'));
  end loop;

  perform private.record_audit(v_target.organization_id, 'member.suspended', v_target.user_id, null,
                               jsonb_build_object('role', v_target.role));
end;
$$;

create or replace function public.reactivate_organization_member(p_member_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_user   uuid := (select auth.uid());
  v_target public.organization_members;
  v_role   text;
begin
  if v_user is null then raise exception 'Not authenticated' using errcode = '28000'; end if;
  select * into v_target from public.organization_members m where m.id = p_member_id for update;
  v_role := case when v_target.id is null then null else private.caller_org_role(v_target.organization_id) end;
  if v_role is null or v_role not in ('OWNER', 'ADMIN') then raise exception 'Not allowed' using errcode = '42501'; end if;
  if v_role = 'ADMIN' and v_target.role <> 'MEMBER' then raise exception 'Admins can reactivate employees only' using errcode = '42501'; end if;
  if v_target.status = 'ACTIVE' then return; end if;
  update public.organization_members m set status = 'ACTIVE', suspended_at = null, suspended_by = null where m.id = v_target.id;
  perform private.record_audit(v_target.organization_id, 'member.reactivated', v_target.user_id, null,
                               jsonb_build_object('role', v_target.role));
  perform private.notify_member(v_target.user_id, v_target.organization_id, 'member.reactivated',
    'Your access was restored', 'An administrator reactivated your membership.',
    '/organizations/' || v_target.organization_id || '/overview', 'member.reactivated:' || v_target.id || ':' || extract(epoch from now())::bigint);
end;
$$;

-- The caller's own suspended memberships (organization name only), so the dashboard can explain the missing access.
create or replace function public.list_my_suspended_memberships()
returns table (organization_id uuid, organization_name text, suspended_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select o.id, o.name, m.suspended_at
  from public.organization_members m join public.organizations o on o.id = m.organization_id
  where m.user_id = (select auth.uid()) and m.status = 'SUSPENDED'
  order by o.name;
$$;

-- 2. Invitation notifications and expiry ---------------------------------------------------------------------------
-- Accepting: unchanged rules; additionally the inviter is notified. An existing (also a suspended) membership is kept
-- as it is: an invitation never reactivates or changes a role.
create or replace function public.accept_organization_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := (select auth.uid());
  v_inv  public.organization_invitations;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token is null or char_length(p_token) not between 20 and 100 then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  select * into v_inv from public.organization_invitations i
  where i.token_hash = private.invitation_token_hash(p_token) for update;
  if v_inv.id is null then
    raise exception 'Invitation not found' using errcode = 'P0002';
  end if;
  if v_inv.status <> 'PENDING' then
    raise exception 'The invitation is no longer valid' using errcode = '55000';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'The invitation has expired' using errcode = '55000';
  end if;
  if v_inv.email is distinct from private.caller_email() then
    raise exception 'This invitation was sent to a different email address' using errcode = '42501';
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (v_inv.organization_id, v_user, v_inv.role)
  on conflict (organization_id, user_id) do nothing;

  update public.organization_invitations i
  set status = 'ACCEPTED', accepted_by = v_user, accepted_at = now()
  where i.id = v_inv.id;
  perform private.record_audit(v_inv.organization_id, 'member.joined', v_user, v_inv.email,
                               jsonb_build_object('role', v_inv.role, 'invitation_id', v_inv.id));
  perform private.notify_member(v_inv.invited_by, v_inv.organization_id, 'member.invitation_accepted',
    coalesce(private.member_label(v_user), v_inv.email) || ' joined as ' || case when v_inv.role = 'ADMIN' then 'admin' else 'employee' end,
    'Invitation for ' || v_inv.email || ' accepted.',
    '/organizations/' || v_inv.organization_id || '/members', 'invitation.accepted:' || v_inv.id);
  return v_inv.organization_id;
end;
$$;

create or replace function public.revoke_organization_invitation(p_invitation_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_inv  public.organization_invitations;
  v_role text;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_inv from public.organization_invitations i where i.id = p_invitation_id for update;
  v_role := case when v_inv.id is null then null else private.caller_org_role(v_inv.organization_id) end;
  if v_role is null or v_role not in ('OWNER', 'ADMIN') or (v_role = 'ADMIN' and v_inv.role <> 'MEMBER') then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_inv.status <> 'PENDING' then
    raise exception 'The invitation is no longer pending' using errcode = '55000';
  end if;
  update public.organization_invitations i
  set status = 'REVOKED', revoked_by = (select auth.uid()), revoked_at = now()
  where i.id = v_inv.id;
  perform private.record_audit(v_inv.organization_id, 'member.invitation_revoked', null, v_inv.email, jsonb_build_object('invitation_id', v_inv.id));
  perform private.notify_member(v_inv.invited_by, v_inv.organization_id, 'member.invitation_revoked',
    'Invitation revoked: ' || v_inv.email, coalesce(private.member_label((select auth.uid())), 'An administrator') || ' revoked it.',
    '/organizations/' || v_inv.organization_id || '/members', 'invitation.revoked:' || v_inv.id);
end;
$$;

-- There is no scheduler: expired invitations are closed (status EXPIRED, audit entry, inviter notified once) when an
-- owner or admin opens the organization's members or overview page, which calls this. Returns how many were closed.
create or replace function public.close_expired_invitations(p_organization_id uuid)
returns int language plpgsql security definer set search_path = '' as $$
declare
  r   record;
  v_n int := 0;
begin
  perform private.require_org_manager(p_organization_id);
  for r in select i.id, i.email, i.invited_by from public.organization_invitations i
           where i.organization_id = p_organization_id and i.status = 'PENDING' and i.expires_at <= now()
           for update loop
    update public.organization_invitations i set status = 'EXPIRED' where i.id = r.id;
    perform private.record_audit(p_organization_id, 'member.invitation_expired', null, r.email, jsonb_build_object('invitation_id', r.id));
    perform private.notify_member(r.invited_by, p_organization_id, 'member.invitation_expired', 'Invitation expired: ' || r.email,
      'Send a new invitation if the person still needs access.', '/organizations/' || p_organization_id || '/members',
      'invitation.expired:' || r.id);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- 3. Departments and teams from CSV -------------------------------------------------------------------------------
-- Rows: DEPARTMENTS [{row, name, description}], TEAMS [{row, department, name, description}]. Names are matched
-- case-insensitively within the organization (teams within their department). Existing entries are UNCHANGED, or
-- UPDATE when a non-empty description differs; new ones CREATE; invalid rows ERROR and are skipped. With p_apply
-- false nothing is written. OWNER/ADMIN only. Creates no members, roles or accounts.
create or replace function public.import_organization_structure(p_organization_id uuid, p_kind text, p_rows jsonb, p_apply boolean)
returns table (row_number int, name text, outcome text, message text)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare
  v_row   jsonb;
  v_num   int;
  v_name  text;
  v_desc  text;
  v_dname text;
  v_dept  uuid;
  v_id    uuid;
  v_cur   text;
  v_seen  text[] := '{}';
  v_key   text;
  v_created int := 0;
  v_updated int := 0;
begin
  perform private.require_org_manager(p_organization_id);
  if p_kind not in ('DEPARTMENTS', 'TEAMS') then raise exception 'Invalid kind' using errcode = '22023'; end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Expected at most 2000 rows' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    v_num  := nullif(v_row ->> 'row', '')::int;
    v_name := btrim(coalesce(v_row ->> 'name', ''));
    v_desc := nullif(btrim(coalesce(v_row ->> 'description', '')), '');
    v_dname := btrim(coalesce(v_row ->> 'department', ''));
    v_dept := null;

    if char_length(v_name) not between 1 and 100 then
      row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'name must be 1-100 characters'; return next; continue;
    end if;
    if v_desc is not null and char_length(v_desc) > 500 then
      row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'description longer than 500 characters'; return next; continue;
    end if;

    if p_kind = 'TEAMS' then
      if v_dname = '' then
        row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'department is required'; return next; continue;
      end if;
      select d.id into v_dept from public.departments d
      where d.organization_id = p_organization_id and lower(btrim(d.name)) = lower(v_dname);
      if v_dept is null then
        row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'unknown department "' || left(v_dname, 100) || '" (import departments first)';
        return next; continue;
      end if;
      v_key := v_dept::text || '/' || lower(v_name);
    else
      v_key := lower(v_name);
    end if;
    if v_key = any (v_seen) then
      row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'duplicate row in the file'; return next; continue;
    end if;
    v_seen := v_seen || v_key;

    if p_kind = 'DEPARTMENTS' then
      select d.id, d.description into v_id, v_cur from public.departments d
      where d.organization_id = p_organization_id and lower(btrim(d.name)) = lower(v_name);
    else
      select t.id, t.description into v_id, v_cur from public.teams t
      where t.department_id = v_dept and lower(btrim(t.name)) = lower(v_name);
    end if;

    if v_id is not null then
      if v_desc is not null and v_desc is distinct from v_cur then
        if p_apply then
          if p_kind = 'DEPARTMENTS' then update public.departments d set description = v_desc where d.id = v_id;
          else update public.teams t set description = v_desc where t.id = v_id; end if;
          v_updated := v_updated + 1;
        end if;
        row_number := v_num; name := v_name; outcome := 'UPDATE'; message := 'description updated'; return next;
      else
        row_number := v_num; name := v_name; outcome := 'UNCHANGED'; message := 'already exists'; return next;
      end if;
      v_id := null;
      continue;
    end if;

    if p_apply then
      begin
        if p_kind = 'DEPARTMENTS' then perform public.create_department(p_organization_id, v_name, v_desc);
        else perform public.create_team(v_dept, v_name, v_desc); end if;
        v_created := v_created + 1;
      exception when unique_violation then
        row_number := v_num; name := v_name; outcome := 'ERROR'; message := 'an entry with this name already exists'; return next; continue;
      end;
    end if;
    row_number := v_num; name := v_name; outcome := 'CREATE';
    message := case when p_kind = 'TEAMS' then 'new team in ' || left(v_dname, 100) else 'new department' end;
    return next;
  end loop;

  if p_apply and (v_created > 0 or v_updated > 0) then
    perform private.record_audit(p_organization_id, 'structure.imported', null, null,
      jsonb_build_object('kind', p_kind, 'created', v_created, 'updated', v_updated));
  end if;
end;
$$;

-- 4. Privileges ----------------------------------------------------------------------------------------------------
revoke all on function public.suspend_organization_member(uuid) from public, anon;
revoke all on function public.reactivate_organization_member(uuid) from public, anon;
revoke all on function public.list_my_suspended_memberships() from public, anon;
revoke all on function public.close_expired_invitations(uuid) from public, anon;
revoke all on function public.import_organization_structure(uuid, text, jsonb, boolean) from public, anon;
grant execute on function public.suspend_organization_member(uuid) to authenticated;
grant execute on function public.reactivate_organization_member(uuid) to authenticated;
grant execute on function public.list_my_suspended_memberships() to authenticated;
grant execute on function public.close_expired_invitations(uuid) to authenticated;
grant execute on function public.import_organization_structure(uuid, text, jsonb, boolean) to authenticated;
