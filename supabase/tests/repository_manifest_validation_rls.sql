-- Manifest payload validation, signature format, privileges and the manifest seal (migration 20261019000001).
-- Every case sends a payload that is SIGNED with the real key wherever a signature can be computed, so the database's
-- own validation (not the HMAC) must reject it. One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_manifest_validation_rls.sql
-- Signing uses the key already in Vault when there is one (read only inside the database, never printed or changed);
-- only when Vault has no key does the test add one, inside this rolled-back transaction.

set client_encoding = 'UTF8';
begin;

create function public.zz_vsig(p_snapshot uuid, p_token text, p_source jsonb, p_files jsonb)
returns text language sql security definer set search_path = '' as $$
  select private.structure_hmac(private.manifest_canonical(p_snapshot, p_token, p_source, p_files), private.structure_persist_key());
$$;
create function public.zz_vsrc(p_accepted int) returns jsonb language sql immutable as $$
  select jsonb_build_object('source_kind','UPLOADED_ARCHIVE','archive_format','ZIP','archive_sha256',repeat('c',64),
    'archive_bytes',100,'archive_commit',null,'entries_total',p_accepted+3,'files_accepted',p_accepted,'files_skipped',3,
    'files_skipped_oversized',1,'files_skipped_generated',2,'files_skipped_metadata',0);
$$;
create function public.zz_vf(p jsonb default '{}') returns jsonb language sql immutable as $$
  select jsonb_build_object('path','a.ts','language','TypeScript','size_bytes',10,'content_hash',repeat('1',64)) || p;
$$;
create table public.zz_vcase (label text, src jsonb, files jsonb, signable boolean, expect text);

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-00000000c101';
  ma     uuid := '00000000-0000-0000-0000-00000000c102';  -- MEMBER, team A
  org1 uuid; d uuid; t uuid; pr uuid; repo uuid; s uuid; s_done uuid; tok text; sig text;
  v record; r record; fn text; st text; msg text; n int; i int := 0;
begin
  insert into auth.users (id, email) values (owner1, 'vo@v.local'), (ma, 'vm@v.local');
  insert into public.organizations (name,slug,created_by) values ('Val','val',owner1) returning id into org1;
  insert into public.organization_members (organization_id,user_id,role) values (org1,owner1,'OWNER'),(org1,ma,'MEMBER');
  insert into public.departments (organization_id,name,slug,created_by) values (org1,'D','d',owner1) returning id into d;
  insert into public.department_members (department_id,user_id) values (d,ma);
  insert into public.teams (department_id,name,slug,created_by) values (d,'T','t',owner1) returning id into t;
  insert into public.team_members (team_id,user_id) values (t,ma);
  insert into public.projects (team_id,name,slug,project_type,created_by) values (t,'P','p','BROWNFIELD',owner1) returning id into pr;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (pr,'GITHUB','https://github.com/v/p','v','p','main',owner1) returning id into repo;
  if not exists (select 1 from vault.secrets where name = 'structure_persist_key') then
    perform vault.create_secret('validation-test-key-0123456789abcdefg', 'structure_persist_key', 'validation test key');
  end if;

  ---------------------------------------------------------------- privileges: key, helpers, private schema, TRUNCATE
  foreach fn in array array['private.manifest_is_int(jsonb,numeric,numeric)', 'private.manifest_payload_check(jsonb,jsonb)',
                            'private.manifest_signature_valid(text,text)', 'private.manifest_canonical(uuid,text,jsonb,jsonb)',
                            'private.structure_persist_key()', 'private.structure_hmac(text,text)', 'private.require_snapshot_admin(uuid)',
                            'private.clear_snapshot_ingestion(uuid)', 'private.snapshot_org(uuid)', 'private.enforce_run_row_window()',
                            'private.enforce_snapshot_run_window()'] loop
    select p.proconfig, p.proacl, pg_get_userbyid(p.proowner) as owner into r from pg_proc p where p.oid = fn::regprocedure;
    assert not has_function_privilege('authenticated', fn, 'execute') and not has_function_privilege('anon', fn, 'execute'), fn || ': not executable by clients';
    assert r.proacl is not null and not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0), fn || ': no PUBLIC execute';
    assert r.proconfig @> array['search_path=""'], fn || ': empty search_path';
    assert r.owner not in ('authenticated', 'anon'), fn || ': not owned by a client role';
  end loop;
  foreach fn in array array['public.begin_snapshot_ingestion(uuid)', 'public.persist_snapshot_manifest(uuid,text,jsonb,jsonb,text)',
                            'public.fail_snapshot_ingestion(uuid,text,text)', 'public.fail_stale_snapshot_ingestion(uuid)'] loop
    select p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) as owner, p.proacl into r from pg_proc p where p.oid = fn::regprocedure;
    assert r.prosecdef and r.proconfig @> array['search_path=""'], fn || ': SECURITY DEFINER with an empty search_path';
    assert r.owner not in ('authenticated', 'anon'), fn || ': not owned by a client role';
    assert not has_function_privilege('anon', fn, 'execute') and not exists (select 1 from aclexplode(r.proacl) a where a.grantee = 0), fn || ': no anon/PUBLIC execute';
  end loop;
  assert not has_schema_privilege('authenticated', 'private', 'usage') and not has_schema_privilege('anon', 'private', 'usage'), 'no client USAGE on private';
  assert not has_schema_privilege('authenticated', 'vault', 'usage') and not has_schema_privilege('anon', 'vault', 'usage'), 'no client USAGE on vault';
  foreach fn in array array['public.repository_files', 'public.repository_snapshot_sources', 'public.repository_snapshots'] loop
    assert not has_table_privilege('authenticated', fn, 'TRUNCATE') and not has_table_privilege('anon', fn, 'TRUNCATE'), fn || ': no client TRUNCATE (would bypass row triggers)';
  end loop;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  st := null; begin perform private.structure_persist_key(); exception when others then st := sqlstate; end;
  assert st = '42501', 'authenticated cannot call the key reader';
  st := null; begin perform private.manifest_signature_valid('x', repeat('0', 64)); exception when others then st := sqlstate; end;
  assert st = '42501', 'authenticated cannot call the signature helper';
  st := null; begin perform count(*) from vault.decrypted_secrets; exception when others then st := sqlstate; end;
  assert st = '42501', 'authenticated cannot read Vault';
  reset role;

  ---------------------------------------------------------------- signed but malformed payloads are rejected, nothing written
  insert into public.zz_vcase values
    ('archive_bytes as JSON string',        public.zz_vsrc(1) || '{"archive_bytes":"100"}',   jsonb_build_array(public.zz_vf()), true, '22023'),
    ('entries_total as JSON string',        public.zz_vsrc(1) || '{"entries_total":"4"}',     jsonb_build_array(public.zz_vf()), true, '22023'),
    ('archive_bytes zero',                  public.zz_vsrc(1) || '{"archive_bytes":0}',       jsonb_build_array(public.zz_vf()), true, '22023'),
    ('archive_bytes fractional',            public.zz_vsrc(1) || '{"archive_bytes":1.5}',     jsonb_build_array(public.zz_vf()), false, '22023'),
    ('files_skipped out of int range',      public.zz_vsrc(1) || '{"files_skipped":3000000000}', jsonb_build_array(public.zz_vf()), false, '22023'),
    ('archive_commit as JSON number',       public.zz_vsrc(1) || '{"archive_commit":1}',      jsonb_build_array(public.zz_vf()), true, '22023'),
    ('unknown source key',                  public.zz_vsrc(1) || '{"verification":"VERIFIED"}', jsonb_build_array(public.zz_vf()), true, '22023'),
    ('negative breakdown that adds up',     public.zz_vsrc(1) || '{"files_skipped_oversized":-1,"files_skipped_generated":4}', jsonb_build_array(public.zz_vf()), true, '22023'),
    ('size_bytes as JSON string',           public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"size_bytes":"10"}')), true, '22023'),
    ('size_bytes fractional',               public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"size_bytes":1.5}')), false, '22023'),
    ('size_bytes negative',                 public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"size_bytes":-1}')), true, '22023'),
    ('size_bytes beyond safe integer',      public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"size_bytes":9007199254740992}')), true, '22023'),
    ('content_hash as JSON number',         public.zz_vsrc(1), jsonb_build_array(public.zz_vf(('{"content_hash":' || repeat('1',64) || '}')::jsonb)), true, '22023'),
    ('content_hash upper case',             public.zz_vsrc(1), jsonb_build_array(public.zz_vf(jsonb_build_object('content_hash', repeat('A',64)))), true, '23514'),
    ('content_hash too short',              public.zz_vsrc(1), jsonb_build_array(public.zz_vf(jsonb_build_object('content_hash', repeat('1',63)))), true, '23514'),
    ('path as JSON number',                 public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":123}')), true, '22023'),
    ('path traversal',                      public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"a/../b.ts"}')), true, '23514'),
    ('path absolute',                       public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"/etc/passwd"}')), true, '23514'),
    ('path with C1 control',                public.zz_vsrc(1), jsonb_build_array(public.zz_vf(jsonb_build_object('path', E'a\u0085b.ts'))), true, '23514'),
    ('path NFC-equivalent duplicates',      public.zz_vsrc(2), jsonb_build_array(public.zz_vf(jsonb_build_object('path', E'café.ts')), public.zz_vf(jsonb_build_object('path', E'café.ts'))), true, '23505'),
    ('path case-insensitive duplicates',    public.zz_vsrc(2), jsonb_build_array(public.zz_vf('{"path":"A.ts"}'), public.zz_vf('{"path":"a.ts"}')), true, '23505'),
    ('path in node_modules',                public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"pkg/node_modules/x.js"}')), true, '23514'),
    ('path in .git',                        public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":".git/config"}')), true, '23514'),
    ('path in __MACOSX',                    public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"__MACOSX/._a.ts"}')), true, '23514'),
    ('sensitive: .env',                     public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"config/.env","language":null}')), true, '23514'),
    ('sensitive: .env.production',          public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":".env.production","language":null}')), true, '23514'),
    ('sensitive: private key',              public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"certs/server.PEM","language":null}')), true, '23514'),
    ('sensitive: ssh key',                  public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":"deploy/id_ed25519","language":null}')), true, '23514'),
    ('sensitive: .npmrc',                   public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"path":".npmrc","language":null}')), true, '23514'),
    ('sensitive count negative',            public.zz_vsrc(1) || '{"files_skipped_sensitive":-1}', jsonb_build_array(public.zz_vf()), true, '22023'),
    ('unknown source kind',                 public.zz_vsrc(1) || '{"source_kind":"GITLAB_ARCHIVE"}', jsonb_build_array(public.zz_vf()), true, '23514'),
    ('language with newline',               public.zz_vsrc(1), jsonb_build_array(public.zz_vf(jsonb_build_object('language', E'Type\nScript'))), true, '22023'),
    ('language as JSON number',             public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"language":5}')), true, '22023'),
    ('language empty',                      public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"language":""}')), true, '22023'),
    ('unknown file key',                    public.zz_vsrc(1), jsonb_build_array(public.zz_vf('{"snapshot_id":"00000000-0000-0000-0000-000000000001"}')), true, '22023'),
    ('file entry not an object',            public.zz_vsrc(1), '["a.ts"]'::jsonb, true, '22023'),
    ('breakdown does not add up',           public.zz_vsrc(1) || '{"files_skipped_metadata":7}', jsonb_build_array(public.zz_vf()), true, '23514'),
    ('entries_total too small',             public.zz_vsrc(1) || '{"entries_total":1}', jsonb_build_array(public.zz_vf()), true, '23514');

  for v in select * from public.zz_vcase loop
    i := i + 1;
    insert into public.repository_snapshots (repository_id, commit_sha, branch) values (repo, lpad(to_hex(i), 40, '0'), 'main') returning id into s;
    set local role authenticated;
    perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
    select run_token into tok from public.begin_snapshot_ingestion(s);
    sig := case when v.signable then public.zz_vsig(s, tok, v.src, v.files) else repeat('0', 64) end;
    st := null; msg := null;
    begin perform public.persist_snapshot_manifest(s, tok, v.src, v.files, sig); exception when others then st := sqlstate; msg := sqlerrm; end;
    reset role;
    assert st = v.expect, format('%s: expected %s, got %s (%s)', v.label, v.expect, coalesce(st, 'ACCEPTED'), coalesce(msg, ''));
    select count(*) into n from public.repository_files where snapshot_id = s;
    assert n = 0, v.label || ': no manifest row written';
    assert not exists (select 1 from public.repository_snapshot_sources where snapshot_id = s), v.label || ': no source record written';
    assert (select status from public.repository_snapshots where id = s) = 'PROCESSING', v.label || ': snapshot still PROCESSING';
    assert exists (select 1 from private.snapshot_ingestion_runs where snapshot_id = s and run_token = tok), v.label || ': token not consumed';
  end loop;

  ---------------------------------------------------------------- signature: malformed formats rejected up front; the HMAC is checked before invariants
  insert into public.repository_snapshots (repository_id, commit_sha, branch) values (repo, repeat('e', 40), 'main') returning id into s;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  select run_token into tok from public.begin_snapshot_ingestion(s);
  sig := public.zz_vsig(s, tok, public.zz_vsrc(1), jsonb_build_array(public.zz_vf()));
  foreach fn in array array[upper(sig), repeat('z', 64), '', left(sig, 63), sig || sig, sig || ' ', ' ' || left(sig, 63)] loop
    st := null; msg := null;
    begin perform public.persist_snapshot_manifest(s, tok, public.zz_vsrc(1), jsonb_build_array(public.zz_vf()), fn);
    exception when others then st := sqlstate; msg := sqlerrm; end;
    assert st = '22023' and msg = 'Malformed manifest signature', format('malformed signature [%s] rejected as 22023, got %s', left(fn, 12), coalesce(st, 'ACCEPTED'));
  end loop;
  st := null; msg := null;
  begin perform public.persist_snapshot_manifest(s, tok, public.zz_vsrc(1) || '{"files_skipped_metadata":7}', jsonb_build_array(public.zz_vf()), repeat('0', 64));
  exception when others then st := sqlstate; msg := sqlerrm; end;
  assert st = '42501' and msg = 'Invalid manifest signature', 'an unsigned caller is stopped by the signature before any invariant is evaluated';
  -- A well-formed, valid signature still works; legitimate values the application produces are accepted.
  select * into r from public.persist_snapshot_manifest(s, tok, public.zz_vsrc(6),
    jsonb_build_array(public.zz_vf('{"path":"src/a.cpp","language":"C++"}'), public.zz_vf('{"path":"src/b.cs","language":"C#"}'),
                      public.zz_vf('{"path":"README","language":null}'), public.zz_vf(jsonb_build_object('path', E'docs/café.md', 'language', 'Markdown')),
                      public.zz_vf('{"path":"node_modules","language":null}'), public.zz_vf('{"path":"docs/build.md","language":"Markdown","size_bytes":0}')),
    public.zz_vsig(s, tok, public.zz_vsrc(6),
    jsonb_build_array(public.zz_vf('{"path":"src/a.cpp","language":"C++"}'), public.zz_vf('{"path":"src/b.cs","language":"C#"}'),
                      public.zz_vf('{"path":"README","language":null}'), public.zz_vf(jsonb_build_object('path', E'docs/café.md', 'language', 'Markdown')),
                      public.zz_vf('{"path":"node_modules","language":null}'), public.zz_vf('{"path":"docs/build.md","language":"Markdown","size_bytes":0}'))));
  assert r.status = 'COMPLETED' and r.files_count = 6, 'valid values (C++, C#, null language, NFD path, a FILE named node_modules, build.md) are accepted';
  s_done := s;
  reset role;

  ---------------------------------------------------------------- manifest V2: sensitive count, env templates, GitHub source kind
  insert into public.repository_snapshots (repository_id, commit_sha, branch) values (repo, repeat('7', 40), 'main') returning id into s;
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  select run_token into tok from public.begin_snapshot_ingestion(s);
  select * into r from public.persist_snapshot_manifest(s, tok,
    public.zz_vsrc(2) || '{"source_kind":"GITHUB_ARCHIVE","files_skipped":5,"files_skipped_sensitive":2,"entries_total":7}',
    jsonb_build_array(public.zz_vf('{"path":".env.example","language":null}'), public.zz_vf('{"path":"src/keyboard.ts"}')),
    public.zz_vsig(s, tok, public.zz_vsrc(2) || '{"source_kind":"GITHUB_ARCHIVE","files_skipped":5,"files_skipped_sensitive":2,"entries_total":7}',
      jsonb_build_array(public.zz_vf('{"path":".env.example","language":null}'), public.zz_vf('{"path":"src/keyboard.ts"}'))));
  assert r.status = 'COMPLETED', 'env templates and look-alike names are not treated as sensitive';
  reset role;
  select * into r from public.repository_snapshot_sources where snapshot_id = s;
  assert r.source_kind = 'GITHUB_ARCHIVE' and r.verification = 'PROVIDER_FETCHED' and r.files_skipped_sensitive = 2, 'GitHub source recorded as PROVIDER_FETCHED with its sensitive count';
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  insert into public.repository_snapshots (repository_id, commit_sha, branch) values (repo, repeat('8', 40), 'main') returning id into s;
  select run_token into tok from public.begin_snapshot_ingestion(s);
  st := null;
  begin
    perform public.persist_snapshot_manifest(s, tok, public.zz_vsrc(1) || '{"files_skipped_sensitive":1}', jsonb_build_array(public.zz_vf()),
      public.zz_vsig(s, tok, public.zz_vsrc(1) || '{"files_skipped_sensitive":1}', jsonb_build_array(public.zz_vf())));
  exception when others then st := sqlstate; end;
  assert st = '23514', 'the sensitive count must add up with the other exclusions to files_skipped';
  reset role;

  ---------------------------------------------------------------- the COMPLETED-manifest seal: ordinary deletes vs cascades
  st := null; begin delete from public.repository_files where snapshot_id = s_done and path = 'README'; exception when others then st := sqlstate; end;
  assert st = '23514', 'an ordinary DELETE from a COMPLETED manifest is refused (even for superuser)';
  st := null; begin delete from public.repository_files where snapshot_id = s_done; exception when others then st := sqlstate; end;
  assert st = '23514', 'a bulk DELETE of a COMPLETED manifest is refused';
  st := null; begin update public.repository_files set path = 'moved' where snapshot_id = s_done and path = 'README'; exception when others then st := sqlstate; end;
  assert st = '23514', 'manifest rows cannot be updated';
  select count(*) into n from public.repository_files where snapshot_id = s_done; assert n = 6, 'COMPLETED manifest unchanged';
  -- Not COMPLETED: the approved workflow (fail_snapshot_ingestion) can clear an attempt's rows.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo, repeat('f', 40), 'main');
  select run_token into tok from public.begin_snapshot_ingestion(s);
  reset role;
  insert into public.repository_files (snapshot_id, path, size_bytes, content_hash) values (s, 'partial.ts', 1, repeat('1', 64));
  set local role authenticated;
  perform public.fail_snapshot_ingestion(s, tok, 'boom');
  reset role;
  select count(*) into n from public.repository_files where snapshot_id = s; assert n = 0, 'a PROCESSING attempt''s rows are cleared when it fails';
  -- Cascades: deleting the snapshot (as OWNER), the repository, or the organization removes a sealed manifest.
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', ma, 'role', 'authenticated')::text, true);
  delete from public.repository_snapshots where id = s_done; get diagnostics n = row_count;
  assert n = 0, 'a MEMBER cannot delete the snapshot (no cascade for them)';
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  delete from public.repository_snapshots where id = s_done; get diagnostics n = row_count;
  assert n = 1, 'OWNER deletes the COMPLETED snapshot as a whole';
  reset role;
  assert not exists (select 1 from public.repository_files where snapshot_id = s_done), 'snapshot delete cascades through the seal';
  -- another sealed manifest, removed by deleting the repository, then the organization
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  select id into s from public.create_repository_snapshot(repo, repeat('d', 40), 'main');
  select run_token into tok from public.begin_snapshot_ingestion(s);
  perform public.persist_snapshot_manifest(s, tok, public.zz_vsrc(1), jsonb_build_array(public.zz_vf()), public.zz_vsig(s, tok, public.zz_vsrc(1), jsonb_build_array(public.zz_vf())));
  reset role;
  assert (select count(*) from public.repository_files where snapshot_id = s) = 1, 'second sealed manifest exists';
  delete from public.repositories where id = repo;
  assert not exists (select 1 from public.repository_files where snapshot_id = s), 'repository delete cascades through the seal';
  assert not exists (select 1 from public.repository_snapshots where repository_id = repo), '...including every snapshot';
  delete from public.organizations where id = org1;
  assert not exists (select 1 from public.projects where id = pr), 'organization delete cascades';

  ---------------------------------------------------------------- deleted between authorization and row lock: refused, not silently "done"
  -- (Simulated by checking the not-found branch: an unknown snapshot is refused by every function.)
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub', owner1, 'role', 'authenticated')::text, true);
  st := null; begin perform public.fail_stale_snapshot_ingestion(s); exception when others then st := sqlstate; end;
  assert st = '42501', 'fail_stale on a deleted snapshot is refused';
  st := null; begin perform public.fail_snapshot_ingestion(s, tok, 'x'); exception when others then st := sqlstate; end;
  assert st = '42501', 'fail on a deleted snapshot is refused';
  reset role;

  raise notice 'repository_manifest_validation_rls.sql: ALL ASSERTIONS PASSED';
end;
$$;

rollback;
