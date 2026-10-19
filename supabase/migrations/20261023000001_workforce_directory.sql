-- Workforce directory: one profile per person and organization (keyed by email, linked to the member's account when
-- they belong to the organization), a normalized skill vocabulary per organization, skills per person, availability.
-- Additive. Directory data never grants a role: roles stay in organization_members and change only through
-- change_member_role(). The CSV import (import_workforce_directory) never creates auth accounts or memberships.
--
-- Writes go through SECURITY DEFINER functions with explicit checks:
--   * OWNER/ADMIN of the organization: import, edit any profile, manage the skill vocabulary
--   * the person themselves (profile.user_id = auth.uid()): their own availability and skills (from the vocabulary)
-- Reads: OWNER/ADMIN see the whole directory; a member sees their own profile; skills are visible to members.

-- 1. Tables ------------------------------------------------------------------------------------------------------
create table public.skills (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name            text not null check (
                    char_length(name) between 1 and 60
                    and name = btrim(name)
                    and name !~ '[[:cntrl:]]'
                    and name ~ '^[[:alnum:]][[:alnum:] +#./&()_-]*$'
                  ),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now()
);
create unique index skills_org_name_key on public.skills (organization_id, lower(name));

create table public.workforce_profiles (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  email           text not null check (
                    email = lower(btrim(email))
                    and char_length(email) between 3 and 320
                    and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                  ),
  user_id         uuid references auth.users (id) on delete set null,
  full_name       text check (char_length(btrim(full_name)) between 1 and 100 and full_name !~ '[[:cntrl:]]'),
  employee_code   text check (char_length(btrim(employee_code)) between 1 and 40 and employee_code !~ '[[:cntrl:]]'),
  job_title       text check (char_length(btrim(job_title)) between 1 and 100 and job_title !~ '[[:cntrl:]]'),
  department_id   uuid references public.departments (id) on delete set null,
  team_id         uuid references public.teams (id) on delete set null,
  availability    text not null default 'AVAILABLE' check (availability in ('AVAILABLE', 'BUSY', 'UNAVAILABLE')),
  source          text not null default 'MANUAL' check (source in ('MANUAL', 'CSV', 'MEMBERSHIP')),
  created_by      uuid references auth.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint workforce_profiles_org_email_key unique (organization_id, email)
);
create unique index workforce_profiles_org_user_key on public.workforce_profiles (organization_id, user_id) where user_id is not null;
create unique index workforce_profiles_org_code_key on public.workforce_profiles (organization_id, lower(employee_code)) where employee_code is not null;
create index workforce_profiles_department_idx on public.workforce_profiles (department_id);
create index workforce_profiles_team_idx on public.workforce_profiles (team_id);

create trigger workforce_profiles_set_updated_at
  before update on public.workforce_profiles
  for each row execute function public.set_updated_at();

create table public.workforce_profile_skills (
  profile_id uuid not null references public.workforce_profiles (id) on delete cascade,
  skill_id   uuid not null references public.skills (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (profile_id, skill_id)
);
create index workforce_profile_skills_skill_idx on public.workforce_profile_skills (skill_id);

-- 2. Integrity: department/team/skill must belong to the profile's organization ---------------------------------
create or replace function private.check_workforce_profile_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_team_dept uuid;
begin
  if new.department_id is not null and not exists (
    select 1 from public.departments d where d.id = new.department_id and d.organization_id = new.organization_id
  ) then
    raise exception 'Department does not belong to this organization' using errcode = '23514';
  end if;
  if new.team_id is not null then
    select t.department_id into v_team_dept
    from public.teams t join public.departments d on d.id = t.department_id
    where t.id = new.team_id and d.organization_id = new.organization_id;
    if v_team_dept is null then
      raise exception 'Team does not belong to this organization' using errcode = '23514';
    end if;
    if new.department_id is null then
      new.department_id := v_team_dept;
    elsif new.department_id <> v_team_dept then
      raise exception 'Team does not belong to the department' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

create trigger workforce_profiles_check_scope
  before insert or update of organization_id, department_id, team_id on public.workforce_profiles
  for each row execute function private.check_workforce_profile_scope();

create or replace function private.check_profile_skill_scope()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.workforce_profiles p join public.skills s on s.organization_id = p.organization_id
    where p.id = new.profile_id and s.id = new.skill_id
  ) then
    raise exception 'Skill does not belong to the profile''s organization' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger workforce_profile_skills_check_scope
  before insert or update on public.workforce_profile_skills
  for each row execute function private.check_profile_skill_scope();

revoke all on function private.check_workforce_profile_scope() from public, anon, authenticated;
revoke all on function private.check_profile_skill_scope() from public, anon, authenticated;

-- 3. RLS and privileges: reads only, writes through functions ----------------------------------------------------
alter table public.skills enable row level security;
alter table public.workforce_profiles enable row level security;
alter table public.workforce_profile_skills enable row level security;

create policy "skills_select_member" on public.skills for select to authenticated
  using (public.is_org_member(organization_id));

create policy "workforce_profiles_select_admin_or_self" on public.workforce_profiles for select to authenticated
  using (public.has_org_role(organization_id, array['OWNER', 'ADMIN']) or user_id = (select auth.uid()));

create policy "workforce_profile_skills_select" on public.workforce_profile_skills for select to authenticated
  using (exists (select 1 from public.workforce_profiles p where p.id = workforce_profile_skills.profile_id));

revoke all on public.skills, public.workforce_profiles, public.workforce_profile_skills from anon, authenticated;
grant select on public.skills, public.workforce_profiles, public.workforce_profile_skills to authenticated;

-- 4. Membership linking ------------------------------------------------------------------------------------------
-- Gives a member's directory entry their home department/team access. Hierarchy rule of the existing policies:
-- organization member -> department member -> team member. Idempotent.
create or replace function private.apply_home_team(p_profile public.workforce_profiles)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_profile.user_id is null then
    return;
  end if;
  if p_profile.department_id is not null then
    insert into public.department_members (department_id, user_id) values (p_profile.department_id, p_profile.user_id)
    on conflict (department_id, user_id) do nothing;
  end if;
  if p_profile.team_id is not null then
    insert into public.team_members (team_id, user_id) values (p_profile.team_id, p_profile.user_id)
    on conflict (team_id, user_id) do nothing;
  end if;
end;
$$;

revoke all on function private.apply_home_team(public.workforce_profiles) from public, anon, authenticated;

-- A new member gets (or is linked to) a directory entry with the same email.
create or replace function private.link_workforce_profile_on_join()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_profile public.profiles;
  v_wp      public.workforce_profiles;
begin
  select * into v_profile from public.profiles p where p.id = new.user_id;
  if v_profile.id is null or v_profile.email is null then
    return new;
  end if;
  insert into public.workforce_profiles as w (organization_id, email, user_id, full_name, source)
  values (new.organization_id, lower(btrim(v_profile.email)), new.user_id, v_profile.display_name, 'MEMBERSHIP')
  on conflict (organization_id, email) do update
    set user_id = excluded.user_id,
        full_name = coalesce(w.full_name, excluded.full_name)
  returning * into v_wp;
  perform private.apply_home_team(v_wp);
  return new;
end;
$$;

create trigger organization_members_link_workforce
  after insert on public.organization_members
  for each row execute function private.link_workforce_profile_on_join();

-- Leaving keeps the directory entry (history) but unlinks the account.
create or replace function private.unlink_workforce_profile_on_leave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.workforce_profiles w set user_id = null
  where w.organization_id = old.organization_id and w.user_id = old.user_id;
  return old;
end;
$$;

create trigger organization_members_unlink_workforce
  after delete on public.organization_members
  for each row execute function private.unlink_workforce_profile_on_leave();

revoke all on function private.link_workforce_profile_on_join() from public, anon, authenticated;
revoke all on function private.unlink_workforce_profile_on_leave() from public, anon, authenticated;

-- Backfill: a directory entry for every existing membership (adds rows only; changes no existing data).
insert into public.workforce_profiles (organization_id, email, user_id, full_name, source)
select m.organization_id, lower(btrim(p.email)), m.user_id, p.display_name, 'MEMBERSHIP'
from public.organization_members m join public.profiles p on p.id = m.user_id
where p.email is not null
on conflict (organization_id, email) do nothing;

-- 5. Functions ---------------------------------------------------------------------------------------------------
create or replace function private.require_org_manager(p_organization_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  if not public.has_org_role(p_organization_id, array['OWNER', 'ADMIN']) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
end;
$$;

revoke all on function private.require_org_manager(uuid) from public, anon, authenticated;

-- Resolve or create a skill by name (case-insensitive). Callers have already checked OWNER/ADMIN.
create or replace function private.ensure_skill(p_organization_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_name text := btrim(regexp_replace(p_name, '[[:space:]]+', ' ', 'g'));
  v_id   uuid;
begin
  select s.id into v_id from public.skills s where s.organization_id = p_organization_id and lower(s.name) = lower(v_name);
  if v_id is null then
    insert into public.skills (organization_id, name, created_by) values (p_organization_id, v_name, (select auth.uid()))
    on conflict (organization_id, lower(name)) do nothing
    returning id into v_id;
    if v_id is null then
      select s.id into v_id from public.skills s where s.organization_id = p_organization_id and lower(s.name) = lower(v_name);
    end if;
  end if;
  return v_id;
end;
$$;

revoke all on function private.ensure_skill(uuid, text) from public, anon, authenticated;

create or replace function public.create_skill(p_organization_id uuid, p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id uuid;
begin
  perform private.require_org_manager(p_organization_id);
  if (select count(*) from public.skills s where s.organization_id = p_organization_id) >= 1000 then
    raise exception 'Too many skills' using errcode = '54000';
  end if;
  v_id := private.ensure_skill(p_organization_id, p_name);
  perform private.record_audit(p_organization_id, 'workforce.skill_created', null, null, jsonb_build_object('skill', btrim(p_name)));
  return v_id;
end;
$$;

-- Edit a directory entry (OWNER/ADMIN). NULL keeps the current value; '' clears a text field.
create or replace function public.update_workforce_profile(
  p_profile_id uuid, p_full_name text, p_employee_code text, p_job_title text, p_department_id uuid, p_team_id uuid,
  p_clear_team boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wp public.workforce_profiles;
begin
  select * into v_wp from public.workforce_profiles w where w.id = p_profile_id for update;
  if v_wp.id is null then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  perform private.require_org_manager(v_wp.organization_id);
  update public.workforce_profiles w set
    full_name     = case when p_full_name is null then w.full_name else nullif(btrim(p_full_name), '') end,
    employee_code = case when p_employee_code is null then w.employee_code else nullif(btrim(p_employee_code), '') end,
    job_title     = case when p_job_title is null then w.job_title else nullif(btrim(p_job_title), '') end,
    department_id = case when p_clear_team then null else coalesce(p_department_id, w.department_id) end,
    team_id       = case when p_clear_team then null else coalesce(p_team_id, w.team_id) end
  where w.id = v_wp.id
  returning * into v_wp;
  perform private.apply_home_team(v_wp);
  perform private.record_audit(v_wp.organization_id, 'workforce.profile_updated', v_wp.user_id, v_wp.email, '{}'::jsonb);
end;
$$;

-- Availability: the person themselves or OWNER/ADMIN.
create or replace function public.set_workforce_availability(p_profile_id uuid, p_availability text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wp public.workforce_profiles;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_wp from public.workforce_profiles w where w.id = p_profile_id for update;
  if v_wp.id is null or not (
    (v_wp.user_id = (select auth.uid()) and public.is_org_member(v_wp.organization_id))
    or public.has_org_role(v_wp.organization_id, array['OWNER', 'ADMIN'])
  ) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if p_availability not in ('AVAILABLE', 'BUSY', 'UNAVAILABLE') then
    raise exception 'Invalid availability' using errcode = '22023';
  end if;
  update public.workforce_profiles w set availability = p_availability where w.id = v_wp.id;
end;
$$;

-- Replace a person's skills with skills from the organization's vocabulary: the person themselves or OWNER/ADMIN.
create or replace function public.set_workforce_skills(p_profile_id uuid, p_skill_ids uuid[])
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_wp public.workforce_profiles;
begin
  if (select auth.uid()) is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;
  select * into v_wp from public.workforce_profiles w where w.id = p_profile_id for update;
  if v_wp.id is null or not (
    (v_wp.user_id = (select auth.uid()) and public.is_org_member(v_wp.organization_id))
    or public.has_org_role(v_wp.organization_id, array['OWNER', 'ADMIN'])
  ) then
    raise exception 'Not allowed' using errcode = '42501';
  end if;
  if coalesce(array_length(p_skill_ids, 1), 0) > 50 then
    raise exception 'Too many skills' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(coalesce(p_skill_ids, '{}')) sid
    where not exists (select 1 from public.skills s where s.id = sid and s.organization_id = v_wp.organization_id)
  ) then
    raise exception 'Unknown skill' using errcode = '22023';
  end if;
  delete from public.workforce_profile_skills ps where ps.profile_id = v_wp.id
    and ps.skill_id <> all (coalesce(p_skill_ids, '{}'));
  insert into public.workforce_profile_skills (profile_id, skill_id)
  select v_wp.id, sid from unnest(coalesce(p_skill_ids, '{}')) sid
  on conflict do nothing;
end;
$$;

-- CSV directory import (OWNER/ADMIN). p_rows: [{row, email, full_name, employee_code, department, team, job_title,
-- skills: [..], availability}] already parsed by the server (src/lib/workforce/csv.ts); every value is validated
-- AGAIN here. Empty values keep the existing value; skills are ADDED (never removed by an import).
-- p_apply = false: dry run, nothing is written (the preview). p_apply = true: valid rows are written in this one
-- transaction; invalid rows are reported and skipped. Returns one result per row.
create or replace function public.import_workforce_directory(p_organization_id uuid, p_rows jsonb, p_apply boolean)
returns table (row_number int, email text, outcome text, message text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_row      jsonb;
  v_email    text;
  v_name     text;
  v_code     text;
  v_title    text;
  v_dept     text;
  v_team     text;
  v_avail    text;
  v_skills   jsonb;
  v_dept_id  uuid;
  v_team_id  uuid;
  v_existing public.workforce_profiles;
  v_wp       public.workforce_profiles;
  v_errors   text[];
  v_seen     text[] := '{}';
  v_codes    text[] := '{}';
  v_changed  boolean;
  v_n        int;
  v_skill    text;
  v_rownum   int;
begin
  perform private.require_org_manager(p_organization_id);
  if jsonb_typeof(p_rows) is distinct from 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Invalid import batch (at most 2000 rows)' using errcode = '22023';
  end if;

  for v_row in select * from jsonb_array_elements(p_rows) loop
    v_errors := '{}';
    v_rownum := case when jsonb_typeof(v_row -> 'row') = 'number' then (v_row ->> 'row')::int else null end;
    if jsonb_typeof(v_row) is distinct from 'object' or exists (
      select 1 from jsonb_object_keys(v_row) k
      where k not in ('row', 'email', 'full_name', 'employee_code', 'department', 'team', 'job_title', 'skills', 'availability')
    ) then
      row_number := v_rownum; email := null; outcome := 'ERROR'; message := 'Unexpected fields in the row.';
      return next;
      continue;
    end if;

    v_email := lower(btrim(coalesce(v_row ->> 'email', '')));
    v_name  := nullif(btrim(coalesce(v_row ->> 'full_name', '')), '');
    v_code  := nullif(btrim(coalesce(v_row ->> 'employee_code', '')), '');
    v_title := nullif(btrim(coalesce(v_row ->> 'job_title', '')), '');
    v_dept  := nullif(btrim(coalesce(v_row ->> 'department', '')), '');
    v_team  := nullif(btrim(coalesce(v_row ->> 'team', '')), '');
    v_avail := nullif(upper(btrim(coalesce(v_row ->> 'availability', ''))), '');
    v_skills := coalesce(v_row -> 'skills', '[]'::jsonb);
    v_dept_id := null; v_team_id := null;

    if v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or char_length(v_email) > 320 then
      v_errors := array_append(v_errors, 'invalid email');
    elsif v_email = any (v_seen) then
      v_errors := array_append(v_errors, 'duplicate email in the file');
    end if;
    if v_name is not null and (char_length(v_name) > 100 or v_name ~ '[[:cntrl:]]') then v_errors := array_append(v_errors, 'invalid full_name'); end if;
    if v_code is not null and (char_length(v_code) > 40 or v_code ~ '[[:cntrl:]]') then v_errors := array_append(v_errors, 'invalid employee_code'); end if;
    if v_title is not null and (char_length(v_title) > 100 or v_title ~ '[[:cntrl:]]') then v_errors := array_append(v_errors, 'invalid job_title'); end if;
    if v_avail is not null and v_avail not in ('AVAILABLE', 'BUSY', 'UNAVAILABLE') then
      v_errors := array_append(v_errors, 'availability must be AVAILABLE, BUSY or UNAVAILABLE');
    end if;
    if jsonb_typeof(v_skills) <> 'array' or jsonb_array_length(v_skills) > 50 or exists (
      select 1 from jsonb_array_elements(v_skills) e
      where jsonb_typeof(e.value) <> 'string' or char_length(btrim(e.value #>> '{}')) not between 1 and 60
         or btrim(e.value #>> '{}') !~ '^[[:alnum:]][[:alnum:] +#./&()_-]*$'
    ) then
      v_errors := array_append(v_errors, 'invalid skills');
    end if;

    if v_dept is not null then
      select d.id into v_dept_id from public.departments d
      where d.organization_id = p_organization_id and lower(btrim(d.name)) = lower(v_dept);
      if v_dept_id is null then v_errors := array_append(v_errors, ('unknown department "' || left(v_dept, 60) || '"')); end if;
    end if;
    if v_team is not null then
      select count(*) into v_n from public.teams t join public.departments d on d.id = t.department_id
      where d.organization_id = p_organization_id and lower(btrim(t.name)) = lower(v_team)
        and (v_dept_id is null or t.department_id = v_dept_id);
      if v_n = 1 then
        select t.id, t.department_id into v_team_id, v_dept_id from public.teams t join public.departments d on d.id = t.department_id
        where d.organization_id = p_organization_id and lower(btrim(t.name)) = lower(v_team)
          and (v_dept_id is null or t.department_id = v_dept_id);
      elsif v_n = 0 then
        v_errors := array_append(v_errors, ('unknown team "' || left(v_team, 60) || '"' || case when v_dept is not null then ' in that department' else '' end));
      else
        v_errors := array_append(v_errors, ('team "' || left(v_team, 60) || '" exists in several departments; add the department'));
      end if;
    end if;

    if v_code is not null and (lower(v_code) = any (v_codes) or exists (
      select 1 from public.workforce_profiles w
      where w.organization_id = p_organization_id and lower(w.employee_code) = lower(v_code) and w.email <> v_email
    )) then
      v_errors := array_append(v_errors, 'employee_code already used by another person');
    end if;

    row_number := v_rownum; email := nullif(v_email, '');
    if cardinality(v_errors) > 0 then
      outcome := 'ERROR'; message := array_to_string(v_errors, '; ');
      return next;
      continue;
    end if;
    v_seen := array_append(v_seen, v_email);
    if v_code is not null then
      v_codes := array_append(v_codes, lower(v_code));
    end if;

    select * into v_existing from public.workforce_profiles w where w.organization_id = p_organization_id and w.email = v_email;
    if v_existing.id is null then
      outcome := 'CREATE';
      message := 'New directory entry (no account or invitation is created).';
    else
      v_changed := (v_name is not null and v_name is distinct from v_existing.full_name)
        or (v_code is not null and v_code is distinct from v_existing.employee_code)
        or (v_title is not null and v_title is distinct from v_existing.job_title)
        or (v_dept_id is not null and v_dept_id is distinct from v_existing.department_id)
        or (v_team_id is not null and v_team_id is distinct from v_existing.team_id)
        or (v_avail is not null and v_avail is distinct from v_existing.availability)
        or exists (
          select 1 from jsonb_array_elements_text(v_skills) sk
          where not exists (
            select 1 from public.workforce_profile_skills ps join public.skills s on s.id = ps.skill_id
            where ps.profile_id = v_existing.id and lower(s.name) = lower(btrim(regexp_replace(sk.value, '[[:space:]]+', ' ', 'g')))
          )
        );
      outcome := case when v_changed then 'UPDATE' else 'UNCHANGED' end;
      message := case when v_changed then 'Existing entry updated (empty cells keep current values).' else 'No changes.' end;
    end if;

    if p_apply and outcome <> 'UNCHANGED' then
      insert into public.workforce_profiles as w
        (organization_id, email, full_name, employee_code, job_title, department_id, team_id, availability, source, created_by)
      values (p_organization_id, v_email, v_name, v_code, v_title, v_dept_id, v_team_id, coalesce(v_avail, 'AVAILABLE'), 'CSV', (select auth.uid()))
      on conflict (organization_id, email) do update set
        full_name     = coalesce(excluded.full_name, w.full_name),
        employee_code = coalesce(excluded.employee_code, w.employee_code),
        job_title     = coalesce(excluded.job_title, w.job_title),
        department_id = case when v_team_id is not null or v_dept_id is not null then excluded.department_id else w.department_id end,
        team_id       = coalesce(excluded.team_id, case when v_dept_id is not null and v_dept_id is distinct from w.department_id then null else w.team_id end),
        availability  = coalesce(v_avail, w.availability)
      returning * into v_wp;
      for v_skill in select btrim(e.value) from jsonb_array_elements_text(v_skills) e loop
        insert into public.workforce_profile_skills (profile_id, skill_id)
        values (v_wp.id, private.ensure_skill(p_organization_id, v_skill))
        on conflict do nothing;
      end loop;
      perform private.apply_home_team(v_wp);
    end if;
    return next;
  end loop;

  if p_apply then
    perform private.record_audit(p_organization_id, 'workforce.imported', null, null,
                                 jsonb_build_object('rows', jsonb_array_length(p_rows)));
  end if;
end;
$$;

revoke all on function public.create_skill(uuid, text) from public, anon;
revoke all on function public.update_workforce_profile(uuid, text, text, text, uuid, uuid, boolean) from public, anon;
revoke all on function public.set_workforce_availability(uuid, text) from public, anon;
revoke all on function public.set_workforce_skills(uuid, uuid[]) from public, anon;
revoke all on function public.import_workforce_directory(uuid, jsonb, boolean) from public, anon;
grant execute on function public.create_skill(uuid, text) to authenticated;
grant execute on function public.update_workforce_profile(uuid, text, text, text, uuid, uuid, boolean) to authenticated;
grant execute on function public.set_workforce_availability(uuid, text) to authenticated;
grant execute on function public.set_workforce_skills(uuid, uuid[]) to authenticated;
grant execute on function public.import_workforce_directory(uuid, jsonb, boolean) to authenticated;
