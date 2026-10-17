-- Project integrations (migration 20261021000001): privileges, roles and tenants, credential isolation, Jira mirror
-- idempotency, missing-issue marking, disconnect keeping data, and GitHub source verification. Rolled back.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/project_integrations_rls.sql

begin;

create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000f101';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-00000000f102';  -- ADMIN of org 1
  ma     uuid := '00000000-0000-0000-0000-00000000f103';  -- MEMBER, team A (sees the project)
  mb     uuid := '00000000-0000-0000-0000-00000000f104';  -- MEMBER, team B (does not)
  owner2 uuid := '00000000-0000-0000-0000-00000000f201';  -- OWNER of org 2
  ct     text := 'v1.' || repeat('A', 16) || '.' || repeat('B', 22) || '.' || repeat('C', 40);
  org1 uuid; org2 uuid; d1 uuid; d2 uuid; ta uuid; tb uuid; tx uuid; p1 uuid; px uuid;
  gh uuid; jira uuid; jx uuid; req uuid; seen1 timestamptz; seen2 timestamptz;
  fn text; r record; n int; st text; msg text;
  page1 jsonb; page2 jsonb;
begin
  insert into auth.users (id, email) values (owner1,'io1@i.local'),(admin1,'ia1@i.local'),(ma,'ima@i.local'),(mb,'imb@i.local'),(owner2,'io2@i.local');
  insert into public.organizations (name,slug,created_by) values ('Int One','int-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Int Two','int-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'D','d',owner2) returning id into d2;
  insert into public.department_members (department_id,user_id) values (d1,ma),(d1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (d1,'A','a',owner1) returning id into ta;
  insert into public.teams (department_id,name,slug,created_by) values (d1,'B','b',owner1) returning id into tb;
  insert into public.teams (department_id,name,slug,created_by) values (d2,'X','x',owner2) returning id into tx;
  insert into public.team_members (team_id,user_id) values (ta,ma),(tb,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (ta,'P','p','BROWNFIELD',owner1) returning id into p1;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (tx,'P','p','BROWNFIELD',owner2) returning id into px;
  insert into public.requirements (project_id,title,created_by) values (p1,'Native requirement',owner1) returning id into req;
  insert into public.tasks (requirement_id,title,created_by) values (req,'Native task',owner1);

  ---------------------------------------------------------------- catalog
  foreach fn in array array['public.save_project_integration(uuid,text,text,boolean,text,text)', 'public.get_integration_ciphertext(uuid)',
                            'public.select_jira_project(uuid,text,text,text)', 'public.record_integration_result(uuid,text,text,text)',
                            'public.disconnect_project_integration(uuid)', 'public.upsert_jira_issues(uuid,jsonb,timestamptz)',
                            'public.mark_missing_jira_issues(uuid,timestamptz)'] loop
    select p.prosecdef, p.proconfig, p.proacl, pg_get_userbyid(p.proowner) as owner into r from pg_proc p where p.oid = fn::regprocedure;
    assert r.prosecdef and r.proconfig @> array['search_path=""'], fn || ': SECURITY DEFINER with empty search_path';
    assert r.owner not in ('authenticated', 'anon'), fn || ': not owned by a client role';
    assert has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'), fn || ': authenticated only';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0), fn || ': no PUBLIC execute';
  end loop;
  foreach fn in array array['private.require_project_admin(uuid)', 'private.integration_project(uuid)', 'private.set_source_verification()'] loop
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'), fn || ': private';
  end loop;
  assert not has_table_privilege('authenticated', 'private.integration_credentials', 'SELECT'), 'credentials table not readable';
  foreach fn in array array['public.project_integrations', 'public.jira_issues'] loop
    assert has_table_privilege('authenticated', fn, 'SELECT'), fn || ': SELECT for clients';
    assert not has_any_column_privilege('authenticated', fn, 'INSERT') and not has_any_column_privilege('authenticated', fn, 'UPDATE')
       and not has_table_privilege('authenticated', fn, 'DELETE') and not has_table_privilege('authenticated', fn, 'TRUNCATE'), fn || ': no direct writes';
    assert not has_any_column_privilege('anon', fn, 'SELECT'), fn || ': anon has nothing';
  end loop;

  ---------------------------------------------------------------- GitHub integration: OWNER saves, MEMBER reads status only
  set local role authenticated;
  perform public.zz_as(owner1);
  gh := public.save_project_integration(p1, 'GITHUB', ct);
  select * into r from public.project_integrations where id = gh;
  assert r.status = 'CONNECTED' and r.has_credential and r.kind = 'GITHUB', 'owner connects GitHub with an encrypted credential';
  assert public.get_integration_ciphertext(gh) = ct, 'owner reads back only the ciphertext';
  assert public.save_project_integration(p1, 'GITHUB') = gh, 'saving again updates the same row (one per project and kind)';
  assert public.get_integration_ciphertext(gh) = ct, 'a NULL credential keeps the stored one';
  st := null; begin perform public.save_project_integration(p1, 'GITHUB', 'plaintext-token'); exception when others then st := sqlstate; end;
  assert st = '23514', 'a plaintext value is refused by the ciphertext format CHECK';
  st := null; begin perform public.save_project_integration(p1, 'SLACK'); exception when others then st := sqlstate; end;
  assert st = '22023', 'unknown kinds are refused';

  perform public.zz_as(ma);
  select count(*) into n from public.project_integrations where project_id = p1; assert n = 1, 'team member sees the integration status';
  st := null; begin perform public.get_integration_ciphertext(gh); exception when others then st := sqlstate; end;
  assert st = '42501', 'team member cannot read the ciphertext';
  st := null; begin perform public.save_project_integration(p1, 'GITHUB', ct); exception when others then st := sqlstate; end;
  assert st = '42501', 'team member cannot save an integration';
  st := null; begin perform count(*) from private.integration_credentials; exception when others then st := sqlstate; end;
  assert st = '42501', 'clients cannot read the credentials table';
  st := null; begin insert into public.project_integrations (project_id, kind) values (p1, 'JIRA'); exception when others then st := sqlstate; end;
  assert st = '42501', 'no direct INSERT on project_integrations';

  foreach fn in array array[mb::text, owner2::text] loop
    perform public.zz_as(fn::uuid);
    select count(*) into n from public.project_integrations where project_id = p1; assert n = 0, 'integration hidden from ' || fn;
    st := null; begin perform public.get_integration_ciphertext(gh); exception when others then st := sqlstate; end;
    assert st = '42501', 'ciphertext refused to ' || fn;
    st := null; begin perform public.save_project_integration(p1, 'GITHUB', ct); exception when others then st := sqlstate; end;
    assert st = '42501', 'save refused to ' || fn;
    st := null; begin perform public.disconnect_project_integration(gh); exception when others then st := sqlstate; end;
    assert st = '42501', 'disconnect refused to ' || fn;
  end loop;

  ---------------------------------------------------------------- Jira: validation, project selection, idempotent import
  perform public.zz_as(admin1);
  st := null; begin perform public.save_project_integration(p1, 'JIRA', ct, false, 'https://evil.example.com', 'a@b.c'); exception when others then st := sqlstate; end;
  assert st = '23514', 'only https://<site>.atlassian.net is accepted';
  st := null; begin perform public.save_project_integration(p1, 'JIRA', ct, false, 'http://acme.atlassian.net', 'a@b.c'); exception when others then st := sqlstate; end;
  assert st = '23514', 'http is refused';
  st := null; begin perform public.save_project_integration(p1, 'GITHUB', ct, false, 'https://acme.atlassian.net', null); exception when others then st := sqlstate; end;
  assert st = '23514', 'Jira fields are refused on a GitHub integration';
  jira := public.save_project_integration(p1, 'JIRA', ct, false, 'https://acme.atlassian.net', 'dev@acme.test');
  st := null; begin perform * from public.upsert_jira_issues(jira, '[]'::jsonb, now()); exception when others then st := sqlstate; end;
  assert st = '55000', 'no import before a Jira project is selected';
  perform public.select_jira_project(jira, '10000', 'ACME', 'Acme project');

  page1 := jsonb_build_array(
    jsonb_build_object('id','10001','key','ACME-1','summary','First','status','To Do','statusCategory','new','issueType','Story','priority','High','assignee','Dev One','updated','2026-10-01T10:00:00.000+0000'),
    jsonb_build_object('id','10002','key','ACME-2','summary','Second','status','Done','statusCategory','done','issueType','Bug','priority',null,'assignee',null,'updated','2026-10-02T10:00:00.000+0000'));
  seen1 := now();
  select * into r from public.upsert_jira_issues(jira, page1, seen1);
  assert r.inserted = 2 and r.updated = 0, 'first import inserts 2';
  select * into r from public.upsert_jira_issues(jira, page1, seen1);
  assert r.inserted = 0 and r.updated = 2, 're-import is idempotent (updates, no duplicates)';
  select count(*) into n from public.jira_issues where project_id = p1; assert n = 2, 'no duplicate rows';
  select * into r from public.jira_issues where issue_key = 'ACME-1';
  assert r.summary = 'First' and r.status_category = 'new' and r.assignee_name = 'Dev One' and r.priority_name = 'High' and r.jira_site = 'https://acme.atlassian.net',
    'mapped fields stored';
  st := null;
  begin perform * from public.upsert_jira_issues(jira, jsonb_build_array(jsonb_build_object('id','20001','key','OTHER-1','summary','x')), now());
  exception when others then st := sqlstate; end;
  assert st = '22023', 'issues of another Jira project are refused';
  st := null;
  begin perform * from public.upsert_jira_issues(jira, (select jsonb_agg(jsonb_build_object('id', g::text, 'key', 'ACME-' || g, 'summary', 's')) from generate_series(1, 201) g), now());
  exception when others then st := sqlstate; end;
  assert st = '22023', 'batches over 200 are refused';
  st := null;
  begin perform * from public.upsert_jira_issues(jira, jsonb_build_array(jsonb_build_object('id', 10003, 'key', 'ACME-3', 'summary', 'x')), now());
  exception when others then st := sqlstate; end;
  assert st = '22023', 'wrong JSON types are refused';

  -- second COMPLETE sync without ACME-2 marks it missing (never deleted)
  page2 := jsonb_build_array(jsonb_build_object('id','10001','key','ACME-1','summary','First (renamed in Jira)','status','In Progress','statusCategory','indeterminate','updated','2026-10-03T10:00:00.000+0000'));
  seen2 := clock_timestamp();
  perform * from public.upsert_jira_issues(jira, page2, seen2);
  assert public.mark_missing_jira_issues(jira, seen2) = 1, 'one issue no longer returned by Jira';
  select count(*) into n from public.jira_issues where project_id = p1; assert n = 2, 'missing issues are kept';
  assert (select missing_in_source from public.jira_issues where issue_key = 'ACME-2'), 'ACME-2 flagged missing';
  assert (select summary from public.jira_issues where issue_key = 'ACME-1') = 'First (renamed in Jira)', 'Jira is authoritative for mirrored fields';
  -- if it comes back, the flag clears
  perform * from public.upsert_jira_issues(jira, page1, clock_timestamp());
  assert not (select missing_in_source from public.jira_issues where issue_key = 'ACME-2'), 'returning issue un-flagged';

  perform public.record_integration_result(jira, 'CONNECTED', 'SUCCEEDED', 'Imported 2 issues');
  select * into r from public.project_integrations where id = jira;
  assert r.last_sync_status = 'SUCCEEDED' and r.last_sync_message = 'Imported 2 issues' and r.last_sync_at is not null, 'sync result recorded';
  perform public.record_integration_result(jira, 'ERROR', 'FAILED', 'Jira rejected the credentials (401).');
  select * into r from public.project_integrations where id = jira;
  assert r.status = 'ERROR' and r.last_error like 'Jira rejected%', 'failure recorded';

  -- changing the site resets the selected project
  perform public.save_project_integration(p1, 'JIRA', null, false, 'https://other.atlassian.net', 'dev@acme.test');
  assert (select jira_project_key from public.project_integrations where id = jira) is null, 'a different site clears the selected project';
  perform public.save_project_integration(p1, 'JIRA', null, false, 'https://acme.atlassian.net', 'dev@acme.test');
  perform public.select_jira_project(jira, '10000', 'ACME', 'Acme project');

  -- MEMBER reads, cannot write
  perform public.zz_as(ma);
  select count(*) into n from public.jira_issues where project_id = p1; assert n = 2, 'team member reads imported issues';
  st := null; begin perform * from public.upsert_jira_issues(jira, page1, now()); exception when others then st := sqlstate; end;
  assert st = '42501', 'team member cannot import';
  st := null; begin perform public.mark_missing_jira_issues(jira, now()); exception when others then st := sqlstate; end;
  assert st = '42501', 'team member cannot mark issues missing';

  -- other tenant: invisible, cannot write into org 1
  perform public.zz_as(owner2);
  select count(*) into n from public.jira_issues; assert n = 0, 'other tenant sees no imported issues';
  st := null; begin perform * from public.upsert_jira_issues(jira, page1, now()); exception when others then st := sqlstate; end;
  assert st = '42501', 'other tenant cannot import into org 1';
  jx := public.save_project_integration(px, 'JIRA', ct, false, 'https://acme.atlassian.net', 'x@x.test');
  perform public.select_jira_project(jx, '10000', 'ACME', 'Same Jira project, other tenant');
  select * into r from public.upsert_jira_issues(jx, page1, now());
  assert r.inserted = 2, 'the same Jira issues can be imported into another tenant''s project (separate rows)';
  perform public.zz_as(owner1);
  select count(*) into n from public.jira_issues; assert n = 2, 'org 1 still sees only its own 2 rows';

  ---------------------------------------------------------------- disconnect keeps data
  perform public.disconnect_project_integration(jira);
  reset role;
  select * into r from public.project_integrations where id = jira;
  assert r.status = 'DISCONNECTED' and not r.has_credential, 'disconnected, credential flag cleared';
  assert not exists (select 1 from private.integration_credentials where integration_id = jira), 'credential removed';
  select count(*) into n from public.jira_issues where project_id = p1; assert n = 2, 'imported issues kept after disconnect';
  select count(*) into n from public.requirements where project_id = p1; assert n = 1, 'native requirements untouched';
  select count(*) into n from public.tasks where requirement_id = req; assert n = 1, 'native tasks untouched';
  set local role authenticated;
  perform public.zz_as(owner1);
  st := null; begin perform * from public.upsert_jira_issues(jira, page1, now()); exception when others then st := sqlstate; end;
  assert st = '55000', 'no import into a disconnected integration';
  perform public.record_integration_result(jira, 'CONNECTED', null, 'late validation');
  assert (select status from public.project_integrations where id = jira) = 'DISCONNECTED', 'a late result does not reconnect';
  reset role;

  raise notice 'project_integrations_rls.sql: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
