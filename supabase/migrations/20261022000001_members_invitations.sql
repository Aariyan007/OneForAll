-- Organization membership management: co-member profile visibility, invitations, role changes, removal and an audit
-- trail. Additive: no existing table, column, policy or row is changed except new policies/grants listed here.
--
-- organization_members keeps NO client write privileges. Every membership change goes through a SECURITY DEFINER
-- function below that resolves the caller from auth.uid() and checks the caller's role in the target organization
-- itself, mirroring src/server/authz/permissions.ts:
--   * invite:      OWNER -> ADMIN or MEMBER; ADMIN -> MEMBER only; nobody can invite an OWNER
--   * role change: OWNER only; never on an OWNER membership, never on oneself, never to OWNER
--   * remove:      OWNER removes ADMIN/MEMBER; ADMIN removes MEMBER; anyone but an OWNER may leave
-- Invitation tokens are 256-bit random values generated here; only their SHA-256 is stored, the raw token is returned
-- once to the inviter. Acceptance requires the token AND a signed-in account whose email equals the invited email.

-- 1. Co-member profiles ------------------------------------------------------------------------------------------
-- A member list or an assignee picker needs the names of people in the same organization. SECURITY DEFINER so the
-- policy can read organization_members without recursion; it only answers about auth.uid().
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
      and theirs.user_id = p_user_id
  );
$$;

revoke all on function public.shares_organization(uuid) from public, anon;
grant execute on function public.shares_organization(uuid) to authenticated;

create policy "profiles_select_co_member"
  on public.profiles for select
  to authenticated
  using (public.shares_organization(id));

-- 2. Audit trail -------------------------------------------------------------------------------------------------
create table public.organization_audit_events (
  id              bigint generated always as identity primary key,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  actor_id        uuid references auth.users (id) on delete set null,
  action          text not null check (action ~ '^[a-z]+(\.[a-z_]+)+$' and char_length(action) <= 64),
  target_user_id  uuid references auth.users (id) on delete set null,
  target_email    text check (char_length(target_email) <= 320),
  details         jsonb not null default '{}'::jsonb
                  check (jsonb_typeof(details) = 'object' and pg_column_size(details) <= 4096),
  created_at      timestamptz not null default now()
);

create index organization_audit_events_org_idx on public.organization_audit_events (organization_id, created_at desc);

alter table public.organization_audit_events enable row level security;

create policy "organization_audit_events_select_admin"
  on public.organization_audit_events for select
  to authenticated
  using (public.has_org_role(organization_id, array['OWNER', 'ADMIN']));

revoke all on public.organization_audit_events from anon, authenticated;
grant select on public.organization_audit_events to authenticated;

-- Written only by the SECURITY DEFINER functions of this and later migrations (they run as the table owner).
create or replace function private.record_audit(
  p_organization_id uuid, p_action text, p_target_user_id uuid, p_target_email text, p_details jsonb
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.organization_audit_events (organization_id, actor_id, action, target_user_id, target_email, details)
  values (p_organization_id, (select auth.uid()), p_action, p_target_user_id, p_target_email, coalesce(p_details, '{}'::jsonb));
$$;

revoke all on function private.record_audit(uuid, text, uuid, text, jsonb) from public, anon, authenticated;

-- The caller's role in an organization (NULL when not a member). Internal helper for the functions below.
create or replace function private.caller_org_role(p_organization_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select m.role from public.organization_members m
  where m.organization_id = p_organization_id and m.user_id = (select auth.uid());
$$;

revoke all on function private.caller_org_role(uuid) from public, anon, authenticated;

-- The caller's auth email, normalized. Internal.
create or replace function private.caller_email()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select lower(btrim(u.email)) from auth.users u where u.id = (select auth.uid());
$$;

revoke all on function private.caller_email() from public, anon, authenticated;

-- 3. Invitations -------------------------------------------------------------------------------------------------
create table public.organization_invitations (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           text not null check (
                    email = lower(btrim(email))
                    and char_length(email) between 3 and 320
                    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                  ),
  role            text not null check (role in ('ADMIN', 'MEMBER')),
  token_hash      bytea not null unique check (octet_length(token_hash) = 32),
  status          text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
  invited_by      uuid references auth.users (id) on delete set null,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now(),
  accepted_by     uuid references auth.users (id) on delete set null,
  accepted_at     timestamptz,
  revoked_by      uuid references auth.users (id) on delete set null,
  revoked_at      timestamptz,
  constraint organization_invitations_expiry check (expires_at > created_at),
  constraint organization_invitations_accepted check ((status = 'ACCEPTED') = (accepted_at is not null)),
  constraint organization_invitations_revoked check ((status = 'REVOKED') = (revoked_at is not null))
);

-- At most one open invitation per address and organization.
create unique index organization_invitations_pending_key
  on public.organization_invitations (organization_id, email) where status = 'PENDING';
create index organization_invitations_email_idx on public.organization_invitations (email) where status = 'PENDING';

alter table public.organization_invitations enable row level security;

create policy "organization_invitations_select_admin"
  on public.organization_invitations for select
  to authenticated
  using (public.has_org_role(organization_id, array['OWNER', 'ADMIN']));

-- token_hash is never readable by clients; no client writes.
revoke all on public.organization_invitations from anon, authenticated;
grant select (id, organization_id, email, role, status, invited_by, expires_at, created_at, accepted_by, accepted_at,
              revoked_by, revoked_at)
  on public.organization_invitations to authenticated;

create or replace function private.invitation_token_hash(p_token text)
returns bytea
language sql
immutable
set search_path = ''
as $$
  select extensions.digest(convert_to(p_token, 'UTF8'), 'sha256');
$$;

revoke all on function private.invitation_token_hash(text) from public, anon, authenticated;

create or replace function public.create_organization_invitation(p_organization_id uuid, p_email text, p_role text)
returns table (invitation_id uuid, token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user  uuid := (select auth.uid());
  v_role  text := private.caller_org_role(p_organization_id);
  v_email text := lower(btrim(p_email));
  v_token text;
  v_id    uuid;
  v_exp   timestamptz := now() + interval '7 days';
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if v_role is null or v_role not in ('OWNER', 'ADMIN') then
    raise exception 'Not allowed to invite members to this organization' using errcode = '42501';
  end if;
  if p_role not in ('ADMIN', 'MEMBER') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if v_role = 'ADMIN' and p_role <> 'MEMBER' then
    raise exception 'Admins can invite employees only' using errcode = '42501';
  end if;
  if v_email is null or char_length(v_email) not between 3 and 320
     or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    raise exception 'Invalid email address' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.organization_members m join public.profiles p on p.id = m.user_id
    where m.organization_id = p_organization_id and lower(p.email) = v_email
  ) then
    raise exception 'This person is already a member' using errcode = '23505';
  end if;

  -- Lazily close expired invitations so the address can be invited again.
  update public.organization_invitations i set status = 'EXPIRED'
  where i.organization_id = p_organization_id and i.email = v_email and i.status = 'PENDING' and i.expires_at <= now();

  if exists (
    select 1 from public.organization_invitations i
    where i.organization_id = p_organization_id and i.email = v_email and i.status = 'PENDING'
  ) then
    raise exception 'An invitation for this address is already pending' using errcode = '23505';
  end if;
  if (select count(*) from public.organization_invitations i
      where i.organization_id = p_organization_id and i.status = 'PENDING') >= 500 then
    raise exception 'Too many pending invitations' using errcode = '54000';
  end if;

  v_token := rtrim(translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/', '-_'), '=');
  insert into public.organization_invitations as i (organization_id, email, role, token_hash, invited_by, expires_at)
  values (p_organization_id, v_email, p_role, private.invitation_token_hash(v_token), v_user, v_exp)
  returning i.id into v_id;

  perform private.record_audit(p_organization_id, 'member.invited', null, v_email, jsonb_build_object('role', p_role, 'invitation_id', v_id));
  return query select v_id, v_token, v_exp;
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
  -- An unknown invitation and a foreign one look the same.
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
end;
$$;

-- What the accept page may show for a token: no organization data for an unknown token.
create or replace function public.get_invitation_preview(p_token text)
returns table (organization_name text, role text, status text, expires_at timestamptz, email_hint text, email_matches boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_inv public.organization_invitations;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if p_token is null or char_length(p_token) not between 20 and 100 then
    return;
  end if;
  select * into v_inv from public.organization_invitations i where i.token_hash = private.invitation_token_hash(p_token);
  if v_inv.id is null then
    return;
  end if;
  return query
    select o.name,
           v_inv.role,
           case when v_inv.status = 'PENDING' and v_inv.expires_at <= now() then 'EXPIRED' else v_inv.status end,
           v_inv.expires_at,
           left(split_part(v_inv.email, '@', 1), 1) || '***@' || split_part(v_inv.email, '@', 2),
           v_inv.email = private.caller_email()
    from public.organizations o where o.id = v_inv.organization_id;
end;
$$;

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
    -- Shown as EXPIRED by get_invitation_preview(); closed for good by the next invitation to the same address.
    raise exception 'The invitation has expired' using errcode = '55000';
  end if;
  if v_inv.email is distinct from private.caller_email() then
    raise exception 'This invitation was sent to a different email address' using errcode = '42501';
  end if;

  -- Already a member (for example invited twice): the invitation is consumed, the existing role is kept.
  insert into public.organization_members (organization_id, user_id, role)
  values (v_inv.organization_id, v_user, v_inv.role)
  on conflict (organization_id, user_id) do nothing;

  update public.organization_invitations i
  set status = 'ACCEPTED', accepted_by = v_user, accepted_at = now()
  where i.id = v_inv.id;
  perform private.record_audit(v_inv.organization_id, 'member.joined', v_user, v_inv.email,
                               jsonb_build_object('role', v_inv.role, 'invitation_id', v_inv.id));
  return v_inv.organization_id;
end;
$$;

-- Pending invitations addressed to the caller (shown on the dashboard; accepting still needs the link's token).
create or replace function public.list_my_invitations()
returns table (invitation_id uuid, organization_name text, role text, expires_at timestamptz, invited_by_name text)
language sql
stable
security definer
set search_path = ''
as $$
  select i.id, o.name, i.role, i.expires_at, coalesce(p.display_name, 'An administrator')
  from public.organization_invitations i
  join public.organizations o on o.id = i.organization_id
  left join public.profiles p on p.id = i.invited_by
  where i.status = 'PENDING' and i.expires_at > now() and i.email = private.caller_email()
  order by i.created_at desc
  limit 50;
$$;

-- 4. Role changes and removal ------------------------------------------------------------------------------------
create or replace function public.change_member_role(p_member_id uuid, p_role text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_target public.organization_members;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_target from public.organization_members m where m.id = p_member_id for update;
  if v_target.id is null or private.caller_org_role(v_target.organization_id) is distinct from 'OWNER' then
    raise exception 'Only an owner can change roles' using errcode = '42501';
  end if;
  if p_role not in ('ADMIN', 'MEMBER') then
    raise exception 'Invalid role' using errcode = '22023';
  end if;
  if v_target.user_id = v_user then
    raise exception 'You cannot change your own role' using errcode = '42501';
  end if;
  if v_target.role = 'OWNER' then
    raise exception 'An owner''s role cannot be changed' using errcode = '42501';
  end if;
  if v_target.role = p_role then
    return;
  end if;
  update public.organization_members m set role = p_role where m.id = v_target.id;
  perform private.record_audit(v_target.organization_id, 'member.role_changed', v_target.user_id, null,
                               jsonb_build_object('from', v_target.role, 'to', p_role));
end;
$$;

create or replace function public.remove_organization_member(p_member_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user   uuid := (select auth.uid());
  v_target public.organization_members;
  v_role   text;
begin
  if v_user is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_target from public.organization_members m where m.id = p_member_id for update;
  v_role := case when v_target.id is null then null else private.caller_org_role(v_target.organization_id) end;
  if v_role is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if v_target.role = 'OWNER' then
    raise exception 'An owner cannot be removed' using errcode = '42501';
  end if;
  if not (v_target.user_id = v_user or v_role = 'OWNER' or (v_role = 'ADMIN' and v_target.role = 'MEMBER')) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  -- Department memberships in this organization go with it (the existing trigger removes the team memberships).
  delete from public.department_members dm
  using public.departments d
  where dm.department_id = d.id and d.organization_id = v_target.organization_id and dm.user_id = v_target.user_id;
  -- Team memberships without a department membership (possible for rows written before the hierarchy rule).
  delete from public.team_members tm
  using public.teams t join public.departments d on d.id = t.department_id
  where tm.team_id = t.id and d.organization_id = v_target.organization_id and tm.user_id = v_target.user_id;

  delete from public.organization_members m where m.id = v_target.id;
  perform private.record_audit(v_target.organization_id,
                               case when v_target.user_id = v_user then 'member.left' else 'member.removed' end,
                               v_target.user_id, null, jsonb_build_object('role', v_target.role));
end;
$$;

revoke all on function public.create_organization_invitation(uuid, text, text) from public, anon;
revoke all on function public.revoke_organization_invitation(uuid) from public, anon;
revoke all on function public.get_invitation_preview(text) from public, anon;
revoke all on function public.accept_organization_invitation(text) from public, anon;
revoke all on function public.list_my_invitations() from public, anon;
revoke all on function public.change_member_role(uuid, text) from public, anon;
revoke all on function public.remove_organization_member(uuid) from public, anon;
grant execute on function public.create_organization_invitation(uuid, text, text) to authenticated;
grant execute on function public.revoke_organization_invitation(uuid) to authenticated;
grant execute on function public.get_invitation_preview(text) to authenticated;
grant execute on function public.accept_organization_invitation(text) to authenticated;
grant execute on function public.list_my_invitations() to authenticated;
grant execute on function public.change_member_role(uuid, text) to authenticated;
grant execute on function public.remove_organization_member(uuid) to authenticated;
