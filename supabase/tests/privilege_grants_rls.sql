-- Privilege hygiene for the client roles (anon, authenticated) across the application schemas, plus the profile
-- behaviour that depends on it. Catalog checks are global on purpose (they must hold for every table and function);
-- the behaviour checks use their own fixture users. Everything runs in one transaction that is rolled back.
-- Run against the local DB:
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/privilege_grants_rls.sql

begin;

do $$
declare
  ua uuid := '00000000-0000-0000-0000-0000000009a1';
  ub uuid := '00000000-0000-0000-0000-0000000009b1';
  bad text;
  n int;
  caught boolean;
begin
  ---------------------------------------------------------------- catalog
  -- RLS is enabled on every application table.
  select string_agg(c.relname, ', ') into bad
  from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and not c.relrowsecurity;
  assert bad is null, format('tables without RLS: %s', bad);

  -- anon (signed-out visitors) holds no table privilege at all; every page needs a session.
  select string_agg(distinct table_schema || '.' || table_name || ':' || privilege_type, ', ') into bad
  from information_schema.role_table_grants
  where grantee = 'anon' and table_schema in ('public', 'private');
  assert bad is null, format('anon table privileges: %s', bad);

  -- TRUNCATE ignores RLS; TRIGGER and REFERENCES are never needed by a client.
  select string_agg(distinct table_schema || '.' || table_name || ':' || privilege_type, ', ') into bad
  from information_schema.role_table_grants
  where grantee in ('anon', 'authenticated') and table_schema in ('public', 'private')
    and privilege_type in ('TRUNCATE', 'TRIGGER', 'REFERENCES');
  assert bad is null, format('client TRUNCATE/TRIGGER/REFERENCES privileges: %s', bad);

  -- No SECURITY DEFINER function is executable by anon, and each one pins its search_path.
  select string_agg(n2.nspname || '.' || p.proname, ', ') into bad
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname in ('public', 'private') and p.prosecdef and has_function_privilege('anon', p.oid, 'EXECUTE');
  assert bad is null, format('SECURITY DEFINER functions executable by anon: %s', bad);

  select string_agg(n2.nspname || '.' || p.proname, ', ') into bad
  from pg_proc p join pg_namespace n2 on n2.oid = p.pronamespace
  where n2.nspname in ('public', 'private') and p.prosecdef
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
  assert bad is null, format('SECURITY DEFINER functions without a fixed search_path: %s', bad);

  -- The auth trigger functions are not callable by clients at all (they only run as triggers).
  assert not has_function_privilege('authenticated', 'public.handle_new_user()', 'EXECUTE'), 'authenticated must not execute handle_new_user';
  assert not has_function_privilege('authenticated', 'public.handle_user_email_change()', 'EXECUTE'), 'authenticated must not execute handle_user_email_change';

  ---------------------------------------------------------------- behaviour
  -- Sign-up still creates the profile, and an email change still reaches it (trigger firing does not check EXECUTE
  -- on the trigger function, so the revokes above do not affect the auth service).
  insert into auth.users (id, email, raw_user_meta_data) values
    (ua, 'grants-a@test.local', '{"display_name":"Grants A"}'),
    (ub, 'grants-b@test.local', '{}');
  update auth.users set email = 'grants-a2@test.local' where id = ua;
  select count(*) into n from public.profiles where id = ua and email = 'grants-a2@test.local' and display_name = 'Grants A';
  assert n = 1, 'profile must be created on sign-up and follow the email change';

  -- A signed-in user still reads and edits their own profile, and only theirs.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  select count(*) into n from public.profiles where id = ua;
  assert n = 1, 'own profile must be readable';
  select count(*) into n from public.profiles where id = ub;
  assert n = 0, 'an unrelated profile must not be readable';
  update public.profiles set display_name = 'Grants A renamed' where id = ua;
  get diagnostics n = row_count;
  assert n = 1, 'own display_name must be editable';

  caught := false;
  begin
    truncate public.profiles;
  exception when insufficient_privilege then caught := true;
  end;
  assert caught, 'authenticated must not truncate profiles';

  caught := false;
  begin
    perform public.handle_new_user();
  exception when insufficient_privilege then caught := true;
  end;
  assert caught, 'authenticated must not call handle_new_user';
  reset role;

  -- Signed out: no profile access at all (not even an empty, RLS-filtered read).
  set local role anon;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  caught := false;
  begin
    perform 1 from public.profiles limit 1;
  exception when insufficient_privilege then caught := true;
  end;
  assert caught, 'anon must not select profiles';

  caught := false;
  begin
    truncate public.profiles;
  exception when insufficient_privilege then caught := true;
  end;
  assert caught, 'anon must not truncate profiles';
  reset role;

  raise notice 'ALL PRIVILEGE GRANT CHECKS PASSED';
end;
$$;

rollback;
