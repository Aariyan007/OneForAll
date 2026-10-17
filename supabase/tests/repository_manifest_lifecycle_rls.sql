-- Manifest and snapshot-lifecycle hardening (migration 20261018000001): no direct client writes to the manifest, the
-- source record or the snapshot lifecycle; ingestion only through begin/persist/fail functions with a one-time run
-- token and an HMAC-signed manifest. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_manifest_lifecycle_rls.sql
-- Signing uses the key already in Vault when there is one (read only inside the database, never printed or changed);
-- only when Vault has no key (an empty test database) does the test add one, inside this rolled-back transaction.

set client_encoding = 'UTF8';
begin;

-- Test helpers (public schema, exist only inside this rolled-back transaction) ---------------------------------
create function public.zz_as(p_user uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
$$;

-- Signs a manifest exactly as the application does (canonical message + HMAC-SHA256), with the Vault key or an
-- explicit one. SECURITY DEFINER only so a test running as `authenticated` can sign; the key never leaves the database.
create function public.zz_msig(p_snapshot uuid, p_token text, p_source jsonb, p_files jsonb, p_key text default null)
returns text language sql security definer set search_path = '' as $$
  select private.structure_hmac(private.manifest_canonical(p_snapshot, p_token, p_source, p_files),
                                coalesce(p_key, private.structure_persist_key()));
$$;

create function public.zz_ssig(p_analysis uuid, p_token text, p_syms jsonb, p_rels jsonb, ft int, fa int, fu int, ff int)
returns text language sql security definer set search_path = '' as $$
  select private.structure_hmac(private.structure_canonical(p_analysis, p_token, p_syms, p_rels, ft, fa, fu, ff),
                                private.structure_persist_key());
$$;

create function public.zz_src(p_accepted int, p_commit text default null, o int default 1, g int default 2, m int default 0)
returns jsonb language sql immutable as $$
  select jsonb_build_object('source_kind', 'UPLOADED_ARCHIVE', 'archive_format', 'ZIP', 'archive_sha256', repeat('c', 64),
    'archive_bytes', 100, 'archive_commit', p_commit, 'entries_total', p_accepted + o + g + m + 2,
    'files_accepted', p_accepted, 'files_skipped', o + g + m,
    'files_skipped_oversized', o, 'files_skipped_generated', g, 'files_skipped_metadata', m);
$$;

create function public.zz_file(p_path text, p_hash text default repeat('1', 64), p_lang text default 'TypeScript', p_size bigint default 10)
returns jsonb language sql immutable as $$
  select jsonb_build_object('path', p_path, 'language', p_lang, 'size_bytes', p_size, 'content_hash', p_hash);
$$;

-- Invoker (keeps the caller's identity): persist with a signature made over exactly what is sent, unless told otherwise.
create function public.zz_persist(p_snapshot uuid, p_token text, p_source jsonb, p_files jsonb, p_key text default null)
returns table (snapshot_id uuid, status text, files_count integer) language sql as $$
  select * from public.persist_snapshot_manifest(p_snapshot, p_token, p_source, p_files,
                                                 public.zz_msig(p_snapshot, p_token, p_source, p_files, p_key));
$$;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-000000000d01';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-000000000d02';  -- ADMIN of org 1 (in no team)
  ma     uuid := '00000000-0000-0000-0000-000000000d03';  -- MEMBER, team A (can read the project)
  mb     uuid := '00000000-0000-0000-0000-000000000d04';  -- MEMBER, team B (cannot see the project)
  owner2 uuid := '00000000-0000-0000-0000-000000000d11';  -- OWNER of org 2 (other tenant)
  other_key text := 'a-different-key-0123456789abcdefghijk';
  h1 text := repeat('1', 64);
  h2 text := repeat('2', 64);
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; team_a uuid; team_b uuid; team_x uuid;
  p_a uuid; p_x uuid; repo_a uuid; repo_x uuid;
  s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; s7 uuid; s_x uuid; an uuid; f1 uuid;
  tok text; tok_a text; tok_b text; tok6 text; tok7 text; atok text;
  files2 jsonb; src2 jsonb; syms jsonb;
  vec_files jsonb; vec_source jsonb; vec_expected text;
  fn text; r record; n int; st text; msg text; caught boolean;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values (owner1,'mo1@m.local'),(admin1,'ma1@m.local'),(ma,'mma@m.local'),(mb,'mmb@m.local'),(owner2,'mo2@m.local');
  insert into public.organizations (name,slug,created_by) values ('Man One','man-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Man Two','man-two',owner2) returning id into org2;
  insert into public.organization_members (organization_id,user_id,role) values
    (org1,owner1,'OWNER'),(org1,admin1,'ADMIN'),(org1,ma,'MEMBER'),(org1,mb,'MEMBER'),(org2,owner2,'OWNER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'Eng','eng',owner1) returning id into dept1;
  insert into public.departments (organization_id,name,slug,created_by) values (org2,'Eng','eng',owner2) returning id into dept2;
  insert into public.department_members (department_id,user_id) values (dept1,ma),(dept1,mb);
  insert into public.teams (department_id,name,slug,created_by) values (dept1,'A','a',owner1) returning id into team_a;
  insert into public.teams (department_id,name,slug,created_by) values (dept1,'B','b',owner1) returning id into team_b;
  insert into public.teams (department_id,name,slug,created_by) values (dept2,'X','x',owner2) returning id into team_x;
  insert into public.team_members (team_id,user_id) values (team_a,ma),(team_b,mb);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_a,'P','p','BROWNFIELD',owner1) returning id into p_a;
  insert into public.projects (team_id,name,slug,project_type,created_by) values (team_x,'P','p','BROWNFIELD',owner2) returning id into p_x;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_a,'GITHUB','https://github.com/m/p','m','p','main',owner1) returning id into repo_a;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_x,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into repo_x;

  -- The HMAC key: use the configured one if present (never read out or changed); otherwise add a test key here.
  if not exists (select 1 from vault.secrets where name = 'structure_persist_key') then
    perform vault.create_secret('manifest-test-key-0123456789abcdefghij', 'structure_persist_key', 'manifest test key');
  end if;

  ---------------------------------------------------------------- catalog: grants, policies, functions
  assert has_table_privilege('authenticated', 'public.repository_files', 'SELECT'), 'files: SELECT kept';
  assert not has_table_privilege('authenticated', 'public.repository_files', 'INSERT'), 'files: no INSERT for clients';
  assert not has_any_column_privilege('authenticated', 'public.repository_files', 'INSERT'), 'files: no column INSERT for clients';
  assert not has_table_privilege('authenticated', 'public.repository_files', 'DELETE'), 'files: no DELETE for clients';
  assert not has_any_column_privilege('authenticated', 'public.repository_files', 'UPDATE'), 'files: no UPDATE for clients';
  assert has_table_privilege('authenticated', 'public.repository_snapshot_sources', 'SELECT'), 'sources: SELECT kept';
  assert not has_any_column_privilege('authenticated', 'public.repository_snapshot_sources', 'INSERT'), 'sources: no INSERT for clients';
  assert not has_table_privilege('authenticated', 'public.repository_snapshot_sources', 'DELETE'), 'sources: no DELETE for clients';
  assert not has_any_column_privilege('authenticated', 'public.repository_snapshot_sources', 'UPDATE'), 'sources: no UPDATE for clients';
  assert has_table_privilege('authenticated', 'public.repository_snapshots', 'SELECT'), 'snapshots: SELECT kept';
  assert has_any_column_privilege('authenticated', 'public.repository_snapshots', 'INSERT'), 'snapshots: INSERT of a PENDING snapshot kept';
  assert has_table_privilege('authenticated', 'public.repository_snapshots', 'DELETE'), 'snapshots: DELETE kept';
  assert not has_any_column_privilege('authenticated', 'public.repository_snapshots', 'UPDATE'), 'snapshots: no UPDATE of any column for clients';
  foreach fn in array array['public.repository_files', 'public.repository_snapshot_sources', 'public.repository_snapshots'] loop
    assert not has_any_column_privilege('anon', fn, 'SELECT') and not has_any_column_privilege('anon', fn, 'INSERT')
       and not has_any_column_privilege('anon', fn, 'UPDATE') and not has_table_privilege('anon', fn, 'DELETE'), fn || ': anon has no privilege';
  end loop;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename in ('repository_files', 'repository_snapshot_sources') and cmd <> 'SELECT';
  assert n = 0, 'files/sources: only SELECT policies remain, saw ' || n;
  select count(*) into n from pg_policies where schemaname = 'public' and tablename = 'repository_snapshots' and cmd in ('UPDATE', 'ALL');
  assert n = 0, 'snapshots: no UPDATE policy remains';
  assert not has_table_privilege('authenticated', 'private.snapshot_ingestion_runs', 'SELECT')
     and not has_schema_privilege('authenticated', 'private', 'usage'), 'run tokens are not readable by clients';
  foreach fn in array array['public.begin_snapshot_ingestion(uuid)', 'public.persist_snapshot_manifest(uuid,text,jsonb,jsonb,text)',
                            'public.fail_snapshot_ingestion(uuid,text,text)', 'public.fail_stale_snapshot_ingestion(uuid)'] loop
    select p.prosecdef, p.proconfig, p.proacl into r from pg_proc p where p.oid = fn::regprocedure;
    assert r.prosecdef, fn || ': SECURITY DEFINER';
    assert r.proconfig @> array['search_path=""'], fn || ': empty search_path';
    assert has_function_privilege('authenticated', fn, 'execute'), fn || ': authenticated can execute';
    assert not has_function_privilege('anon', fn, 'execute'), fn || ': anon cannot execute';
    assert not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'), fn || ': no PUBLIC execute';
  end loop;
  foreach fn in array array['private.snapshot_org(uuid)', 'private.require_snapshot_admin(uuid)',
                            'private.manifest_canonical(uuid,text,jsonb,jsonb)', 'private.clear_snapshot_ingestion(uuid)'] loop
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'), fn || ': not executable by clients';
    select p.proconfig into r from pg_proc p where p.oid = fn::regprocedure;
    assert r.proconfig @> array['search_path=""'], fn || ': empty search_path';
  end loop;

  ---------------------------------------------------------------- canonical form and HMAC agree with Node (fixed vector)
  -- Computed with canonicalManifest/signManifest (src/server/repository-files/signing.ts, format V2) for exactly this input.
  vec_source := jsonb_build_object('source_kind', 'UPLOADED_ARCHIVE', 'archive_format', 'ZIP', 'archive_sha256', repeat('c', 64),
    'archive_bytes', 9999999999, 'archive_commit', null, 'entries_total', 7, 'files_accepted', 3, 'files_skipped', 3,
    'files_skipped_oversized', 1, 'files_skipped_generated', 2, 'files_skipped_metadata', 0, 'files_skipped_sensitive', 0);
  vec_files := jsonb_build_array(
    public.zz_file('src/a|b.ts', repeat('1', 64), 'TypeScript', 10),
    public.zz_file(E'ünïcode/файл.ts', repeat('2', 64), null, 0),
    public.zz_file('README.md', repeat('3', 64), 'Markdown', 9999999999));
  vec_expected := E'OFA-MANIFEST-V2\n11111111-2222-3333-4444-555555555555\n' || repeat('ab', 32) || E'\n'
    || 'SRC|UPLOADED_ARCHIVE|ZIP|' || repeat('c', 64) || E'|9999999999|-|7|3|3|1|2|0|0\n3\n'
    || 'F|10:src/a|b.ts|10:TypeScript|10|' || repeat('1', 64) || E'\n'
    || E'F|21:ünïcode/файл.ts|-|0|' || repeat('2', 64) || E'\n'
    || 'F|9:README.md|8:Markdown|9999999999|' || repeat('3', 64) || E'\n';
  assert private.manifest_canonical('11111111-2222-3333-4444-555555555555', repeat('ab', 32), vec_source, vec_files) = vec_expected,
    'database canonical manifest equals the Node canonical manifest';
  assert private.structure_hmac(vec_expected, 'manifest-vector-key-0123456789abcdefgh') = 'd3a4a06f379317ea5b01878ead4f1ce7c81856ad345e2ccf152bfa4e61423984',
    'database HMAC-SHA256 of the manifest equals the Node signature';
  assert private.manifest_canonical('11111111-2222-3333-4444-555555555555', repeat('ab', 32), vec_source, vec_files)
      <> private.manifest_canonical('11111111-2222-3333-4444-555555555556', repeat('ab', 32), vec_source, vec_files), 'the snapshot id is part of the message';

  ---------------------------------------------------------------- normal snapshot creation still works
  set local role authenticated;
  perform public.zz_as(owner1);
  select id into s1 from public.create_repository_snapshot(repo_a, repeat('a', 40), 'main');
  select id into s3 from public.create_repository_snapshot(repo_a, repeat('3', 40), 'main');
  select id into s4 from public.create_repository_snapshot(repo_a, repeat('4', 40), 'main');
  select id into s6 from public.create_repository_snapshot(repo_a, repeat('6', 40), 'main');
  select id into s7 from public.create_repository_snapshot(repo_a, repeat('6', 40), 'release');
  perform public.zz_as(admin1);
  select id into s2 from public.create_repository_snapshot(repo_a, repeat('b', 40), 'main');
  perform public.zz_as(owner2);
  select id into s_x from public.create_repository_snapshot(repo_x, repeat('a', 40), 'main');
  assert s1 is not null and s2 is not null and s_x is not null, 'OWNER/ADMIN create PENDING snapshots through the RPC';
  reset role;

  -- Superuser puts one existing file on s3 (an earlier attempt's leftover), to check that a new attempt clears it.
  insert into public.repository_files (snapshot_id, path, size_bytes, content_hash) values (s3, 'leftover.txt', 1, h1);

  ---------------------------------------------------------------- anonymous and unauthenticated callers
  set local role anon;
  st := null; begin perform public.begin_snapshot_ingestion(s1); exception when others then st := sqlstate; end;
  assert st = '42501', 'anon cannot execute begin_snapshot_ingestion; got ' || coalesce(st, 'no error');
  st := null; begin perform public.fail_stale_snapshot_ingestion(s1); exception when others then st := sqlstate; end;
  assert st = '42501', 'anon cannot execute fail_stale_snapshot_ingestion';
  reset role;
  set local role authenticated;
  perform set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  st := null; begin perform public.begin_snapshot_ingestion(s1); exception when others then st := sqlstate; end;
  assert st = '28000', 'a caller without a user id is refused (28000); got ' || coalesce(st, 'no error');

  ---------------------------------------------------------------- direct Data API writes are denied for every client role
  for r in select uid, who from (values (owner1, 'OWNER'), (admin1, 'ADMIN'), (ma, 'team MEMBER'), (owner2, 'other-tenant OWNER')) as x(uid, who) loop
    perform public.zz_as(r.uid);
    st := null; begin insert into public.repository_files (snapshot_id, path, size_bytes, content_hash) values (s1, 'forged.ts', 1, h1); exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct INSERT into repository_files denied; got ' || coalesce(st, 'no error');
    st := null; begin delete from public.repository_files where snapshot_id = s3; exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct DELETE from repository_files denied; got ' || coalesce(st, 'no error');
    st := null; begin update public.repository_files set size_bytes = 2 where snapshot_id = s3; exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct UPDATE of repository_files denied';
    st := null; begin update public.repository_snapshots set status = 'PROCESSING', started_at = now() where id = s1; exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct snapshot lifecycle UPDATE denied; got ' || coalesce(st, 'no error');
    st := null; begin update public.repository_snapshots set error_message = 'x' where id = s1; exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct snapshot error_message UPDATE denied';
    st := null;
    begin
      insert into public.repository_snapshot_sources (snapshot_id, source_kind, archive_format, archive_sha256, archive_bytes, entries_total, files_accepted, files_skipped, uploaded_by)
        values (s1, 'UPLOADED_ARCHIVE', 'ZIP', h1, 1, 1, 1, 0, r.uid);
    exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct INSERT into repository_snapshot_sources denied';
    st := null; begin delete from public.repository_snapshot_sources where snapshot_id = s1; exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': direct DELETE from repository_snapshot_sources denied';
  end loop;
  reset role;
  select count(*) into n from public.repository_files where snapshot_id in (s1, s3); assert n = 1, 'no direct write changed the manifest';
  assert (select status from public.repository_snapshots where id = s1) = 'PENDING', 'no direct write changed the snapshot';

  ---------------------------------------------------------------- MEMBER and other tenant cannot use the functions
  set local role authenticated;
  for r in select uid, who, sid from (values (ma, 'team MEMBER', s1), (mb, 'other-team MEMBER', s1), (owner2, 'other-tenant OWNER', s1), (owner1, 'org 1 OWNER on org 2', s_x)) as x(uid, who, sid) loop
    perform public.zz_as(r.uid);
    st := null; msg := null; begin perform public.begin_snapshot_ingestion(r.sid); exception when others then st := sqlstate; msg := sqlerrm; end;
    assert st = '42501' and msg = 'Snapshot not found', r.who || ': begin_snapshot_ingestion denied; got ' || coalesce(st, 'no error');
    st := null; begin perform public.zz_persist(r.sid, repeat('0', 64), public.zz_src(1), jsonb_build_array(public.zz_file('a.ts'))); exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': persist_snapshot_manifest denied';
    st := null; begin perform public.fail_snapshot_ingestion(r.sid, repeat('0', 64), 'x'); exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': fail_snapshot_ingestion denied';
    st := null; begin perform public.fail_stale_snapshot_ingestion(r.sid); exception when others then st := sqlstate; end;
    assert st = '42501', r.who || ': fail_stale_snapshot_ingestion denied';
  end loop;
  perform public.zz_as(owner1);
  st := null; begin perform public.begin_snapshot_ingestion('00000000-0000-0000-0000-00000000ffff'); exception when others then st := sqlstate; end;
  assert st = '42501', 'an unknown snapshot is indistinguishable from a forbidden one';
  reset role;
  assert (select status from public.repository_snapshots where id = s1) = 'PENDING'
     and (select status from public.repository_snapshots where id = s_x) = 'PENDING', 'denied calls changed nothing';

  ---------------------------------------------------------------- OWNER: authorized ingestion, and every way to cheat it
  set local role authenticated;
  perform public.zz_as(owner1);
  select * into r from public.begin_snapshot_ingestion(s1);
  tok := r.run_token;
  assert r.snapshot_id = s1 and tok ~ '^[0-9a-f]{64}$', 'OWNER begins ingestion and receives a run token';
  st := null; msg := null; begin perform public.begin_snapshot_ingestion(s1); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '55000' and msg = 'Snapshot is already being processed', 'a concurrent second begin is refused';
  reset role;
  select * into r from public.repository_snapshots where id = s1;
  assert r.status = 'PROCESSING' and r.started_at is not null and r.completed_at is null, 'begin moves PENDING -> PROCESSING';
  assert (select run_token from private.snapshot_ingestion_runs where snapshot_id = s1) = tok, 'the run token is stored privately';
  set local role authenticated;
  perform public.zz_as(owner1);

  files2 := jsonb_build_array(public.zz_file('src/a.ts', h1), public.zz_file('README.md', h2, 'Markdown', 5));
  src2 := public.zz_src(2);

  st := null; msg := null; begin perform public.zz_persist(s1, tok, src2, files2, other_key); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'a manifest signed with another key is rejected; got ' || coalesce(msg, 'no error');
  st := null; msg := null;
  begin perform public.persist_snapshot_manifest(s1, tok, src2,
          jsonb_build_array(public.zz_file('src/a.ts', h2), public.zz_file('README.md', h2, 'Markdown', 5)),
          public.zz_msig(s1, tok, src2, files2));
  exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'a forged hash under a valid signature is rejected';
  st := null; msg := null;
  begin perform public.persist_snapshot_manifest(s1, tok, src2, files2 || jsonb_build_array(public.zz_file('extra.ts')), public.zz_msig(s1, tok, src2, files2));
  exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'an added file under a valid signature is rejected';
  st := null; msg := null;
  begin perform public.persist_snapshot_manifest(s1, tok, src2 || '{"files_skipped_metadata": 1}'::jsonb, files2, public.zz_msig(s1, tok, src2, files2));
  exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'changed source counts under a valid signature are rejected';
  st := null; msg := null;
  begin perform public.persist_snapshot_manifest(s1, tok, src2, files2, public.zz_msig(s2, tok, src2, files2));
  exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'a signature made for another snapshot cannot be re-targeted';
  st := null; msg := null; begin perform public.zz_persist(s1, repeat('e', 64), src2, files2); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid run token', 'a guessed run token is rejected';
  st := null; msg := null; begin perform public.persist_snapshot_manifest(s1, tok, src2, files2, null); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '22023', 'a missing signature is rejected';
  -- Correctly signed but violating the ingestion invariants:
  st := null; msg := null; begin perform public.zz_persist(s1, tok, public.zz_src(0), '[]'::jsonb); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '23514' and msg like 'A snapshot needs between 1 and 5000%', 'an EMPTY manifest cannot complete a snapshot; got ' || coalesce(msg, 'no error');
  st := null; msg := null; begin perform public.zz_persist(s1, tok, public.zz_src(3), files2); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '23514' and msg = 'files_accepted does not match the manifest', 'an INCOMPLETE manifest (fewer files than accepted) cannot complete';
  st := null; msg := null; begin perform public.zz_persist(s1, tok, src2 - 'files_skipped_generated', files2); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '23514' and msg = 'The exclusion breakdown is required', 'a source record without the exclusion breakdown is refused';
  st := null; msg := null; begin perform public.zz_persist(s1, tok, public.zz_src(2, repeat('f', 40)), files2); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '23514' and msg = 'The archive claims a different commit', 'an archive claiming another commit is refused';
  st := null; begin perform public.zz_persist(s1, tok, src2 || '{"files_skipped": 4}'::jsonb, files2); exception when others then st := sqlstate; end;
  assert st = '23514', 'exclusion counts that do not add up are refused (table CHECK)';
  st := null; begin perform public.zz_persist(s1, tok, public.zz_src(1), jsonb_build_array(public.zz_file('../escape.ts'))); exception when others then st := sqlstate; end;
  assert st = '23514', 'a path-traversal entry is refused (table CHECK), even when signed';
  st := null; begin perform public.zz_persist(s1, tok, public.zz_src(2), jsonb_build_array(public.zz_file('dup.ts'), public.zz_file('dup.ts'))); exception when others then st := sqlstate; end;
  assert st = '23505', 'a duplicate path within one manifest is refused';
  st := null; begin perform public.zz_persist(s1, tok, public.zz_src(1), jsonb_build_array(jsonb_build_object('path', 'nohash.ts', 'size_bytes', 1))); exception when others then st := sqlstate; end;
  assert st = '22023', 'an entry without a content hash is refused';
  st := null; begin perform public.persist_snapshot_manifest(s1, tok, src2, '{"not":"an array"}'::jsonb, 'x'); exception when others then st := sqlstate; end;
  assert st = '22023', 'a non-array manifest is refused';
  reset role;
  select * into r from public.repository_snapshots where id = s1;
  assert r.status = 'PROCESSING', 'every rejected persist left the snapshot PROCESSING';
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 0, 'every rejected persist wrote no manifest row';
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s1; assert n = 0, 'every rejected persist wrote no source record';
  assert exists (select 1 from private.snapshot_ingestion_runs where snapshot_id = s1 and run_token = tok), 'a rejected persist does not consume the token';

  set local role authenticated;
  perform public.zz_as(owner1);
  select * into r from public.zz_persist(s1, tok, src2, files2);
  assert r.snapshot_id = s1 and r.status = 'COMPLETED' and r.files_count = 2, 'a correctly signed, consistent manifest completes the snapshot';
  -- Replay of the exact same, valid request:
  st := null; msg := null; begin perform public.zz_persist(s1, tok, src2, files2); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '55000', 'replaying a persisted manifest is refused; got ' || coalesce(st, 'no error');
  reset role;
  select * into r from public.repository_snapshots where id = s1;
  assert r.status = 'COMPLETED' and r.completed_at is not null and r.error_message is null, 'snapshot COMPLETED';
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 2, 'the manifest has exactly the signed files';
  select * into r from public.repository_snapshot_sources where snapshot_id = s1;
  assert r.uploaded_by = owner1 and r.verification = 'UNVERIFIED' and r.files_accepted = 2 and r.files_skipped = 3
     and r.files_skipped_oversized = 1 and r.files_skipped_generated = 2 and r.files_skipped_metadata = 0,
     'the source record is written by the database: uploader = caller, UNVERIFIED, signed counts';
  assert not exists (select 1 from private.snapshot_ingestion_runs where snapshot_id = s1), 'completion consumes the run token';

  ---------------------------------------------------------------- COMPLETED snapshot and manifest are immutable
  set local role authenticated;
  perform public.zz_as(owner1);
  st := null; begin perform public.begin_snapshot_ingestion(s1); exception when others then st := sqlstate; end;
  assert st = '55000', 'a COMPLETED snapshot cannot be ingested again';
  st := null; begin perform public.fail_snapshot_ingestion(s1, tok, 'x'); exception when others then st := sqlstate; end;
  assert st = '55000', 'a COMPLETED snapshot cannot be failed';
  st := null; begin perform public.fail_stale_snapshot_ingestion(s1); exception when others then st := sqlstate; end;
  assert st = '55000', 'a COMPLETED snapshot cannot be failed as stale';
  reset role;
  -- Defense in depth: even a writer that bypasses grants and RLS (superuser, or any future definer function).
  select id into f1 from public.repository_files where snapshot_id = s1 and path = 'src/a.ts';
  st := null; begin insert into public.repository_files (snapshot_id, path, size_bytes, content_hash) values (s1, 'late.ts', 1, h1); exception when others then st := sqlstate; end;
  assert st = '23514', 'no row can be added to a COMPLETED manifest, by anyone';
  st := null; begin delete from public.repository_files where id = f1; exception when others then st := sqlstate; end;
  assert st = '23514', 'no row can be removed from a COMPLETED manifest, by anyone';
  st := null; begin update public.repository_files set content_hash = h2 where id = f1; exception when others then st := sqlstate; end;
  assert st = '23514', 'manifest rows are never updated, by anyone';
  st := null; begin update public.repository_snapshots set status = 'PENDING' where id = s1; exception when others then st := sqlstate; end;
  assert st = '23514', 'COMPLETED stays terminal (lifecycle trigger)';
  st := null; begin insert into private.snapshot_ingestion_runs (snapshot_id, run_token) values (s1, repeat('a', 64)); exception when others then st := sqlstate; end;
  assert st = '23514', 'a run token cannot exist for a COMPLETED snapshot';
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 2, 'the completed manifest is unchanged';

  ---------------------------------------------------------------- ADMIN (in no team): authorized ingestion with a matching commit claim
  set local role authenticated;
  perform public.zz_as(admin1);
  select run_token into atok from public.begin_snapshot_ingestion(s2);
  select * into r from public.zz_persist(s2, atok, public.zz_src(1, repeat('b', 40)), jsonb_build_array(public.zz_file('main.py', h1, 'Python')));
  assert r.status = 'COMPLETED' and r.files_count = 1, 'ADMIN ingests a snapshot of a team they are not in';
  reset role;
  assert (select archive_commit from public.repository_snapshot_sources where snapshot_id = s2) = repeat('b', 40), 'a matching commit claim is recorded';
  assert (select uploaded_by from public.repository_snapshot_sources where snapshot_id = s2) = admin1, 'uploader is the ADMIN';

  ---------------------------------------------------------------- failed upload and retry through the approved workflow
  set local role authenticated;
  perform public.zz_as(owner1);
  select run_token into tok_a from public.begin_snapshot_ingestion(s3);
  reset role;
  select count(*) into n from public.repository_files where snapshot_id = s3; assert n = 0, 'a new attempt clears an earlier attempt''s leftovers';
  set local role authenticated;
  perform public.zz_as(owner1);
  st := null; begin perform public.fail_snapshot_ingestion(s3, repeat('9', 64), 'x'); exception when others then st := sqlstate; end;
  assert st = '42501', 'failing an attempt needs its run token';
  select * into r from public.fail_snapshot_ingestion(s3, tok_a, '  Could not record the file manifest. Try again.  ');
  assert r.status = 'FAILED', 'the attempt is marked FAILED with its token';
  reset role;
  select * into r from public.repository_snapshots where id = s3;
  assert r.status = 'FAILED' and r.error_message = 'Could not record the file manifest. Try again.' and r.completed_at is not null, 'FAILED with a trimmed, safe message';
  assert not exists (select 1 from private.snapshot_ingestion_runs where snapshot_id = s3), 'failing consumes the run token';
  set local role authenticated;
  perform public.zz_as(owner1);
  st := null; begin perform public.zz_persist(s3, tok_a, public.zz_src(1), jsonb_build_array(public.zz_file('a.ts'))); exception when others then st := sqlstate; end;
  assert st = '55000', 'a FAILED snapshot cannot be completed (the failed attempt cannot be replayed)';
  select run_token into tok_b from public.begin_snapshot_ingestion(s3);
  assert tok_b <> tok_a, 'retry: FAILED -> PROCESSING with a fresh run token';
  st := null; msg := null; begin perform public.zz_persist(s3, tok_a, public.zz_src(1), jsonb_build_array(public.zz_file('a.ts'))); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid run token', 'the failed attempt''s token cannot be replayed into the retry';
  select * into r from public.zz_persist(s3, tok_b, public.zz_src(1), jsonb_build_array(public.zz_file('a.ts')));
  assert r.status = 'COMPLETED' and r.files_count = 1, 'the retried upload completes';
  reset role;
  select * into r from public.repository_snapshots where id = s3;
  assert r.status = 'COMPLETED' and r.error_message is null, 'retry clears the failure';

  ---------------------------------------------------------------- crash recovery: only a stale PROCESSING snapshot can be failed without a token
  set local role authenticated;
  perform public.zz_as(owner1);
  perform public.begin_snapshot_ingestion(s4);
  st := null; msg := null; begin perform public.fail_stale_snapshot_ingestion(s4); exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '55000' and msg = 'Snapshot started processing recently', 'a recent PROCESSING snapshot cannot be failed without its token';
  reset role;
  update public.repository_snapshots set started_at = now() - interval '11 minutes' where id = s4;
  set local role authenticated;
  perform public.zz_as(ma);
  st := null; begin perform public.fail_stale_snapshot_ingestion(s4); exception when others then st := sqlstate; end;
  assert st = '42501', 'a MEMBER cannot fail a stale snapshot';
  perform public.zz_as(admin1);
  select * into r from public.fail_stale_snapshot_ingestion(s4);
  assert r.status = 'FAILED', 'ADMIN fails a stale PROCESSING snapshot';
  reset role;
  assert not exists (select 1 from private.snapshot_ingestion_runs where snapshot_id = s4), 'stale recovery removes the run token';
  assert (select error_message from public.repository_snapshots where id = s4) = 'Processing did not finish. Upload the archive again to retry.', 'stale recovery message';

  ---------------------------------------------------------------- one COMPLETED snapshot per commit, including under a race
  set local role authenticated;
  perform public.zz_as(owner1);
  select id into s5 from public.create_repository_snapshot(repo_a, repeat('a', 40), 'other');
  st := null; begin perform public.begin_snapshot_ingestion(s5); exception when others then st := sqlstate; end;
  assert st = '23505', 'begin refuses a commit that is already COMPLETED in this repository';
  reset role;
  assert (select status from public.repository_snapshots where id = s5) = 'PENDING', '...before changing anything';
  set local role authenticated;
  perform public.zz_as(owner1);
  select run_token into tok6 from public.begin_snapshot_ingestion(s6);
  select run_token into tok7 from public.begin_snapshot_ingestion(s7);
  perform public.zz_persist(s6, tok6, public.zz_src(1), jsonb_build_array(public.zz_file('a.ts')));
  st := null; begin perform public.zz_persist(s7, tok7, public.zz_src(1), jsonb_build_array(public.zz_file('a.ts'))); exception when others then st := sqlstate; end;
  assert st = '23505', 'the losing upload of a race is refused at completion';
  reset role;
  select * into r from public.repository_snapshots where id = s7;
  assert r.status = 'PROCESSING', 'the loser is still PROCESSING (the app then fails it with its token)';
  select count(*) into n from public.repository_files where snapshot_id = s7; assert n = 0, 'the loser recorded no manifest (atomic)';
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s7; assert n = 0, 'the loser recorded no source (atomic)';
  set local role authenticated;
  perform public.zz_as(owner1);
  perform public.fail_snapshot_ingestion(s7, tok7, 'A completed snapshot of this commit already exists for this repository.');

  ---------------------------------------------------------------- structure analysis and graph reads still work on an ingested snapshot
  select id into an from public.create_structure_analysis(s1);
  select run_token into atok from public.begin_structure_analysis(an);
  syms := jsonb_build_array(jsonb_build_object('file_id', f1, 'name', 'Svc', 'kind', 'CLASS', 'qualified_name', null, 'signature', null,
          'start_line', 0, 'start_column', 0, 'end_line', 1, 'end_column', 0, 'visibility', 'UNKNOWN'));
  select * into r from public.persist_structure_analysis(an, atok, syms, '[]'::jsonb, 2, 1, 1, 0, public.zz_ssig(an, atok, syms, '[]'::jsonb, 2, 1, 1, 0));
  assert r.status = 'COMPLETED' and r.symbols_count = 1, 'structure analysis of an ingested snapshot completes';
  perform public.zz_as(ma);
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 2, 'team MEMBER reads the manifest (graph)';
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s1; assert n = 1, 'team MEMBER reads the source record';
  select count(*) into n from public.repository_symbols where analysis_id = an; assert n = 1, 'team MEMBER reads the structure (graph)';
  perform public.zz_as(mb);
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 0, 'other-team MEMBER reads no manifest';
  perform public.zz_as(owner2);
  select count(*) into n from public.repository_files where snapshot_id = s1; assert n = 0, 'other tenant reads no manifest';
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s1; assert n = 0, 'other tenant reads no source record';

  ---------------------------------------------------------------- deleting a whole snapshot still works and cascades
  perform public.zz_as(admin1);
  delete from public.repository_snapshots where id = s2; get diagnostics n = row_count;
  assert n = 1, 'ADMIN can still delete a COMPLETED snapshot as a whole';
  reset role;
  assert not exists (select 1 from public.repository_files where snapshot_id = s2), 'its sealed manifest cascades with it';
  assert not exists (select 1 from public.repository_snapshot_sources where snapshot_id = s2), 'its source record cascades with it';

  raise notice 'repository_manifest_lifecycle_rls.sql: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
