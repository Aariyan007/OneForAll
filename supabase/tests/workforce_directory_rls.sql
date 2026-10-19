-- Workforce directory: linking, visibility, CSV import (dry run / apply / idempotency / rejections), profile edits.
-- One transaction, rolled back at the end. Fixture rows only; no global counts.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/workforce_directory_rls.sql

begin;

do $$
declare
  o1 uuid := '00000000-0000-0000-0000-0000000002a1';  -- OWNER  org 1
  a1 uuid := '00000000-0000-0000-0000-0000000002a2';  -- ADMIN  org 1
  m1 uuid := '00000000-0000-0000-0000-0000000002a3';  -- MEMBER org 1
  m2 uuid := '00000000-0000-0000-0000-0000000002a4';  -- MEMBER org 1
  j1 uuid := '00000000-0000-0000-0000-0000000002a5';  -- joins org 1 later (listed in the CSV first)
  o2 uuid := '00000000-0000-0000-0000-0000000002b1';  -- OWNER  org 2
  org1 uuid; org2 uuid; d_eng uuid; d_qa uuid; d_other uuid; t_web uuid; t_web_qa uuid; t_api uuid; p_web uuid;
  wp_m1 uuid; wp_m2 uuid; sk_react uuid; sk_foreign uuid;
  r record; n int; caught boolean; v_rows jsonb;
begin
  insert into auth.users (id, email, raw_user_meta_data) values
    (o1, 'o1@wf.local', '{"display_name":"Olivia Owner"}'), (a1, 'a1@wf.local', '{}'), (m1, 'm1@wf.local', '{"display_name":"Mia"}'),
    (m2, 'm2@wf.local', '{}'), (j1, 'joiner@wf.local', '{}'), (o2, 'o2@wf.local', '{}');
  insert into public.organizations (name, slug, created_by) values ('WF One', 'wf-one', o1) returning id into org1;
  insert into public.organizations (name, slug, created_by) values ('WF Two', 'wf-two', o2) returning id into org2;
  insert into public.organization_members (organization_id, user_id, role) values
    (org1, o1, 'OWNER'), (org1, a1, 'ADMIN'), (org1, m1, 'MEMBER'), (org1, m2, 'MEMBER'), (org2, o2, 'OWNER');
  insert into public.departments (organization_id, name, slug, created_by) values (org1, 'Engineering', 'engineering', o1) returning id into d_eng;
  insert into public.departments (organization_id, name, slug, created_by) values (org1, 'Quality', 'quality', o1) returning id into d_qa;
  insert into public.departments (organization_id, name, slug, created_by) values (org2, 'Secret Lab', 'secret-lab', o2) returning id into d_other;
  insert into public.teams (department_id, name, slug, created_by) values (d_eng, 'Web', 'web', o1) returning id into t_web;
  insert into public.teams (department_id, name, slug, created_by) values (d_qa, 'Web', 'web', o1) returning id into t_web_qa;
  insert into public.teams (department_id, name, slug, created_by) values (d_eng, 'API', 'api', o1) returning id into t_api;
  insert into public.projects (team_id, name, slug, project_type, created_by) values (t_api, 'Gateway', 'gateway', 'BROWNFIELD', o1) returning id into p_web;
  insert into public.skills (organization_id, name) values (org2, 'Foreign Skill') returning id into sk_foreign;

  ------------------------------------------------------------------ linking on join
  select id into wp_m1 from public.workforce_profiles where organization_id = org1 and user_id = m1;
  select id into wp_m2 from public.workforce_profiles where organization_id = org1 and user_id = m2;
  assert wp_m1 is not null and wp_m2 is not null, 'every member gets a directory entry';
  select full_name, source, email into r from public.workforce_profiles where id = wp_m1;
  assert r.full_name = 'Mia' and r.source = 'MEMBERSHIP' and r.email = 'm1@wf.local', 'entry built from the profile';
  assert not has_table_privilege('authenticated', 'public.workforce_profiles', 'insert'), 'no client insert';
  assert not has_table_privilege('authenticated', 'public.workforce_profiles', 'update'), 'no client update';
  assert not has_table_privilege('authenticated', 'public.workforce_profile_skills', 'insert'), 'no client insert on skills';

  set local role authenticated;

  ------------------------------------------------------------------ visibility
  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.workforce_profiles where organization_id = org1;
  assert n = 4, 'an admin sees the whole directory';
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.workforce_profiles where organization_id = org1;
  assert n = 1, 'an employee sees only their own entry';
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  select count(*) into n from public.workforce_profiles where organization_id = org1;
  assert n = 0, 'other tenants see nothing';

  ------------------------------------------------------------------ import: authorization
  v_rows := '[{"row":2,"email":"Joiner@WF.local","full_name":"Jo Iner","employee_code":"EMP-9","department":"engineering","team":"API","job_title":"Backend Engineer","skills":["Python","FastAPI"],"availability":"available"}]';
  caught := false;
  begin perform * from public.import_workforce_directory(org1, v_rows, false); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot import into org 1';
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform * from public.import_workforce_directory(org1, v_rows, false); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot import';

  ------------------------------------------------------------------ import: dry run, apply, idempotency
  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  v_rows := '[
    {"row":2,"email":"Joiner@WF.local","full_name":"Jo Iner","employee_code":"EMP-9","department":"engineering","team":"API","job_title":"Backend Engineer","skills":["Python","FastAPI"],"availability":"available"},
    {"row":3,"email":"m1@wf.local","full_name":"","employee_code":"","department":"Engineering","team":"Web","job_title":"Frontend Engineer","skills":["React","TypeScript"],"availability":""},
    {"row":4,"email":"bad-email","full_name":"X"},
    {"row":5,"email":"joiner@wf.local","full_name":"Dup"},
    {"row":6,"email":"ghost@wf.local","department":"Secret Lab"},
    {"row":7,"email":"amb@wf.local","team":"Web"},
    {"row":8,"email":"role@wf.local","role":"OWNER"},
    {"row":9,"email":"busy@wf.local","availability":"ON_LEAVE"},
    {"row":10,"email":"code@wf.local","employee_code":"emp-9"},
    {"row":11,"email":"qa@wf.local","department":"Quality","team":"Web","skills":["API Testing"]}
  ]';
  create temp table t_res on commit drop as select * from public.import_workforce_directory(org1, v_rows, false);
  select count(*) into n from t_res where outcome = 'CREATE';
  assert n = 2, 'dry run: two new entries (joiner, qa)';
  select count(*) into n from t_res where outcome = 'UPDATE' and email = 'm1@wf.local';
  assert n = 1, 'dry run: existing member updated';
  select count(*) into n from t_res where outcome = 'ERROR';
  assert n = 7, 'dry run: seven rejected rows';
  select message into r from t_res where row_number = 4;   assert r.message like '%invalid email%', 'invalid email';
  select message into r from t_res where row_number = 5;   assert r.message like '%duplicate email%', 'duplicate email in file (case-insensitive)';
  select message into r from t_res where row_number = 6;   assert r.message like '%unknown department%', 'another tenant''s department is unknown';
  select message into r from t_res where row_number = 7;   assert r.message like '%several departments%', 'ambiguous team name';
  select message into r from t_res where row_number = 8;   assert r.message like '%Unexpected fields%', 'a role column is rejected';
  select message into r from t_res where row_number = 9;   assert r.message like '%availability%', 'invalid availability';
  select message into r from t_res where row_number = 10;  assert r.message like '%employee_code already used%', 'employee code taken (case-insensitive, by a row of the same file)';
  select count(*) into n from public.workforce_profiles where organization_id = org1 and email in ('joiner@wf.local', 'qa@wf.local');
  assert n = 0, 'dry run writes nothing';
  drop table t_res;

  create temp table t_res on commit drop as select * from public.import_workforce_directory(org1, v_rows, true);
  select count(*) into n from public.workforce_profiles where organization_id = org1 and email in ('joiner@wf.local', 'qa@wf.local');
  assert n = 2, 'apply creates the valid rows';
  select w.full_name, w.employee_code, w.job_title, w.department_id, w.team_id, w.availability, w.user_id into r
  from public.workforce_profiles w where w.organization_id = org1 and w.email = 'joiner@wf.local';
  assert r.full_name = 'Jo Iner' and r.employee_code = 'EMP-9' and r.department_id = d_eng and r.team_id = t_api
         and r.availability = 'AVAILABLE' and r.user_id is null, 'values stored; not linked (no account in org yet)';
  select w.full_name, w.job_title, w.team_id, w.availability into r from public.workforce_profiles w where w.id = wp_m1;
  assert r.full_name = 'Mia' and r.job_title = 'Frontend Engineer' and r.team_id = t_web and r.availability = 'AVAILABLE',
    'empty cells keep current values';
  select count(*) into n from public.workforce_profile_skills ps join public.skills s on s.id = ps.skill_id
  where ps.profile_id = wp_m1 and s.name in ('React', 'TypeScript');
  assert n = 2, 'skills added and created in the vocabulary';
  select count(*) into n from public.team_members where team_id = t_web and user_id = m1;
  assert n = 1, 'a linked member gets access to their home team';
  select count(*) into n from public.organization_members where organization_id = org1
    and ((user_id = o1 and role = 'OWNER') or (user_id = a1 and role = 'ADMIN') or (user_id in (m1, m2) and role = 'MEMBER'));
  assert n = 4, 'the import changed no role';
  drop table t_res;

  create temp table t_res on commit drop as select * from public.import_workforce_directory(org1, v_rows, true);
  select count(*) into n from t_res where outcome = 'UNCHANGED';
  assert n = 3, 're-importing the same file changes nothing';
  select count(*) into n from public.workforce_profiles where organization_id = org1 and email = 'joiner@wf.local';
  assert n = 1, 'no duplicate entries';
  drop table t_res;

  ------------------------------------------------------------------ a CSV entry is linked when the person joins
  reset role;
  insert into public.organization_members (organization_id, user_id, role) values (org1, j1, 'MEMBER');
  select w.user_id, w.full_name into r from public.workforce_profiles w where w.organization_id = org1 and w.email = 'joiner@wf.local';
  assert r.user_id = j1 and r.full_name = 'Jo Iner', 'joining links the existing entry and keeps its data';
  select count(*) into n from public.team_members where team_id = t_api and user_id = j1;
  assert n = 1, 'joining applies the home team';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', j1, 'role', 'authenticated')::text, true);
  select count(*) into n from public.projects where id = p_web;
  assert n = 1, 'through the home team the new member sees the team''s project';

  ------------------------------------------------------------------ profile edits
  perform set_config('request.jwt.claims', json_build_object('sub', m1, 'role', 'authenticated')::text, true);
  perform public.set_workforce_availability(wp_m1, 'BUSY');
  caught := false;
  begin perform public.set_workforce_availability(wp_m2, 'UNAVAILABLE'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot change someone else''s availability';
  caught := false;
  begin perform public.set_workforce_availability(wp_m1, 'ON_LEAVE'); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'invalid availability refused';
  caught := false;
  begin perform public.update_workforce_profile(wp_m1, 'Mia', null, 'CTO', null, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot edit protected fields (even their own)';
  select id into sk_react from public.skills where organization_id = org1 and name = 'React';
  perform public.set_workforce_skills(wp_m1, array[sk_react]);
  select count(*) into n from public.workforce_profile_skills where profile_id = wp_m1;
  assert n = 1, 'an employee sets their own skills from the vocabulary';
  caught := false;
  begin perform public.set_workforce_skills(wp_m1, array[sk_foreign]); exception when sqlstate '22023' then caught := true; end;
  assert caught, 'a skill of another organization is refused';
  caught := false;
  begin perform public.set_workforce_skills(wp_m2, array[sk_react]); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot set someone else''s skills';
  caught := false;
  begin perform public.create_skill(org1, 'Rust'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'an employee cannot extend the vocabulary';

  perform set_config('request.jwt.claims', json_build_object('sub', a1, 'role', 'authenticated')::text, true);
  perform public.update_workforce_profile(wp_m2, 'Max', 'EMP-2', 'QA Engineer', d_qa, null);
  select full_name, department_id into r from public.workforce_profiles where id = wp_m2;
  assert r.full_name = 'Max' and r.department_id = d_qa, 'an admin edits a directory entry';
  caught := false;
  begin perform public.update_workforce_profile(wp_m2, null, null, null, d_other, null); exception when sqlstate '23514' then caught := true; end;
  assert caught, 'a department of another organization is refused';
  caught := false;
  begin perform public.update_workforce_profile(wp_m2, null, null, null, d_eng, t_web_qa); exception when sqlstate '23514' then caught := true; end;
  assert caught, 'a team outside the department is refused';
  perform public.set_workforce_availability(wp_m2, 'UNAVAILABLE');
  perform public.create_skill(org1, 'Rust');
  perform set_config('request.jwt.claims', json_build_object('sub', o2, 'role', 'authenticated')::text, true);
  caught := false;
  begin perform public.update_workforce_profile(wp_m2, 'Hacked', null, null, null, null); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot edit org 1 entries';
  caught := false;
  begin perform public.set_workforce_availability(wp_m2, 'AVAILABLE'); exception when insufficient_privilege then caught := true; end;
  assert caught, 'another tenant cannot change availability';

  ------------------------------------------------------------------ leaving unlinks, keeps the entry
  reset role;
  delete from public.organization_members where organization_id = org1 and user_id = m2;
  select user_id, full_name into r from public.workforce_profiles where id = wp_m2;
  assert r.user_id is null and r.full_name = 'Max', 'leaving unlinks the account and keeps the directory entry';

  raise notice 'ALL WORKFORCE CHECKS PASSED';
end;
$$;

rollback;
