-- Source-archive ingestion: authorization, isolation and immutability of repository_snapshot_sources.
-- One transaction, rolled back at the end.
--   docker exec -i supabase_db_OneForAll psql -U postgres -v ON_ERROR_STOP=1 < supabase/tests/repository_snapshot_sources_rls.sql
-- Since migration 20261018000001 no client can write this table directly: the record is written only by
-- persist_snapshot_manifest() together with the manifest (see repository_manifest_lifecycle_rls.sql, which also covers
-- the failure and retry path). The table rules below hold for every writer, so they are exercised as superuser.

begin;

do $$
declare
  owner1 uuid := '00000000-0000-0000-0000-000000000a01';  -- OWNER of org 1
  admin1 uuid := '00000000-0000-0000-0000-000000000a02';  -- ADMIN of org 1
  ma     uuid := '00000000-0000-0000-0000-000000000a03';  -- MEMBER of org 1, team A (can see the project)
  mb     uuid := '00000000-0000-0000-0000-000000000a04';  -- MEMBER of org 1, team B (cannot see the project)
  owner2 uuid := '00000000-0000-0000-0000-000000000b01';  -- OWNER of org 2 (other tenant)
  h      text := repeat('1', 64);
  org1 uuid; org2 uuid; dept1 uuid; dept2 uuid; team_a uuid; team_b uuid; team_x uuid;
  p_a uuid; p_x uuid; repo_a uuid; repo_x uuid; s_a uuid; s_done uuid; s_x uuid;
  v record; n int; caught boolean;
begin
  -- Fixtures (superuser) ----------------------------------------------------
  insert into auth.users (id, email) values (owner1,'so1@s.local'),(admin1,'sa1@s.local'),(ma,'sma@s.local'),(mb,'smb@s.local'),(owner2,'so2@s.local');
  insert into public.organizations (name,slug,created_by) values ('Src One','src-one',owner1) returning id into org1;
  insert into public.organizations (name,slug,created_by) values ('Src Two','src-two',owner2) returning id into org2;
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
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_a,'GITHUB','https://github.com/a/p','a','p','main',owner1) returning id into repo_a;
  insert into public.repositories (project_id,provider,repository_url,owner,name,default_branch,created_by) values (p_x,'GITHUB','https://github.com/x/p','x','p','main',owner2) returning id into repo_x;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,repeat('a',40),'main') returning id into s_a;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_a,repeat('b',40),'main') returning id into s_done;
  insert into public.repository_snapshots (repository_id,commit_sha,branch) values (repo_x,repeat('a',40),'main') returning id into s_x;
  -- a legacy record (written before the exclusion breakdown existed) on a completed snapshot
  insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by)
    values (s_done,'UPLOADED_ARCHIVE','ZIP',h,100,2,2,0,owner1);
  update public.repository_snapshots set status='PROCESSING', started_at=now() where id=s_done;
  update public.repository_snapshots set status='COMPLETED', completed_at=now() where id=s_done;

  ---------------------------------------------------------------- anonymous denied
  set local role anon;
  caught := false; begin perform count(*) from public.repository_snapshot_sources; exception when insufficient_privilege then caught := true; end;
  assert caught, 'anon must not read snapshot sources';
  reset role;

  ---------------------------------------------------------------- no client can write source records (any role, any snapshot state)
  set local role authenticated;
  for v in select uid, who, sid from (values
      (owner1,'OWNER (pending snapshot)',s_a),(owner1,'OWNER (completed snapshot)',s_done),(admin1,'ADMIN',s_a),
      (ma,'team MEMBER',s_a),(owner2,'other-tenant OWNER',s_a),(owner1,'org 1 OWNER on org 2',s_x)) as x(uid, who, sid) loop
    perform set_config('request.jwt.claims', json_build_object('sub',v.uid,'role','authenticated')::text, true);
    caught := false;
    begin
      insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by)
        values (v.sid,'UPLOADED_ARCHIVE','ZIP',h,10,1,1,0,v.uid);
    exception when insufficient_privilege then caught := true; end;
    assert caught, v.who || ': direct insert of a source record denied';
    caught := false;
    begin
      insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by,verification)
        values (v.sid,'UPLOADED_ARCHIVE','ZIP',h,10,1,1,0,v.uid,'UNVERIFIED');
    exception when insufficient_privilege then caught := true; end;
    assert caught, v.who || ': clients must not write the verification column';
    caught := false; begin delete from public.repository_snapshot_sources where snapshot_id = v.sid; exception when insufficient_privilege then caught := true; end;
    assert caught, v.who || ': direct delete of a source record denied';
    caught := false; begin update public.repository_snapshot_sources set files_accepted = 3 where snapshot_id = v.sid; exception when insufficient_privilege then caught := true; end;
    assert caught, v.who || ': source records are immutable (no update)';
  end loop;
  reset role;
  select count(*) into n from public.repository_snapshot_sources where snapshot_id in (s_a, s_done, s_x); assert n = 1, 'no denied write changed the source records';

  ---------------------------------------------------------------- table rules (hold for every writer, including the persistence function)
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by,verification)
      values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,1,1,0,owner1,'VERIFIED');
  exception when check_violation then caught := true; end;
  assert caught, 'only UNVERIFIED can be recorded';
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by)
      values (s_a,'GITHUB_VERIFIED','ZIP',h,10,1,1,0,owner1);
  exception when check_violation then caught := true; end;
  assert caught, 'unknown source kinds are rejected';
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by)
      values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,1,2,0,owner1);
  exception when check_violation then caught := true; end;
  assert caught, 'accepted + skipped cannot exceed the entries in the archive';
  -- exclusion breakdown: all three or none, and it must add up exactly to files_skipped
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,files_skipped_oversized,files_skipped_generated,files_skipped_metadata,uploaded_by)
      values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,3,2,1,1,1,0,owner1);
  exception when check_violation then caught := true; end;
  assert caught, 'an exclusion breakdown that does not add up is rejected';
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,files_skipped_oversized,uploaded_by)
      values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,3,2,1,1,owner1);
  exception when check_violation then caught := true; end;
  assert caught, 'a partial exclusion breakdown is rejected';
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,files_skipped_oversized,files_skipped_generated,files_skipped_metadata,uploaded_by)
      values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,3,2,1,-1,2,0,owner1);
  exception when check_violation then caught := true; end;
  assert caught, 'negative exclusion counts are rejected';
  -- a valid record with its exclusion breakdown
  insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,archive_commit,entries_total,files_accepted,files_skipped,files_skipped_oversized,files_skipped_generated,files_skipped_metadata,uploaded_by)
    values (s_a,'UPLOADED_ARCHIVE','ZIP',h,10,repeat('a',40),3,2,1,0,1,0,owner1);
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s_a and verification = 'UNVERIFIED';
  assert n = 1, 'a recorded source defaults to UNVERIFIED';
  -- rows written before the breakdown existed keep NULL ("not recorded"), never zero
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s_done and files_skipped_oversized is null and files_skipped_generated is null and files_skipped_metadata is null;
  assert n = 1, 'legacy rows keep a NULL breakdown';
  caught := false;
  begin
    insert into public.repository_snapshot_sources (snapshot_id,source_kind,archive_format,archive_sha256,archive_bytes,entries_total,files_accepted,files_skipped,uploaded_by)
      values (s_done,'UPLOADED_ARCHIVE','ZIP',h,10,1,1,0,owner1);
  exception when unique_violation then caught := true; end;
  assert caught, 'one source record per snapshot';

  ---------------------------------------------------------------- visibility follows the snapshot
  set local role authenticated;
  perform set_config('request.jwt.claims', json_build_object('sub',owner1,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshot_sources where snapshot_id in (s_a, s_done); assert n = 2, 'owner sees org 1 sources';
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s_x; assert n = 0, 'other tenant invisible';
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshot_sources where snapshot_id in (s_a, s_done); assert n = 2, 'admin sees org 1 sources';
  perform set_config('request.jwt.claims', json_build_object('sub',ma,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshot_sources where snapshot_id in (s_a, s_done);
  assert n = 2, 'team member sees the sources of visible snapshots';
  perform set_config('request.jwt.claims', json_build_object('sub',mb,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshot_sources;
  assert n = 0, 'member of another team sees no sources';
  perform set_config('request.jwt.claims', json_build_object('sub',owner2,'role','authenticated')::text, true);
  select count(*) into n from public.repository_snapshot_sources where snapshot_id in (s_a, s_done);
  assert n = 0, 'other tenant cannot read org 1 sources';

  ---------------------------------------------------------------- deleting a snapshot removes its source record
  perform set_config('request.jwt.claims', json_build_object('sub',admin1,'role','authenticated')::text, true);
  delete from public.repository_snapshots where id = s_done; get diagnostics n = row_count;
  assert n = 1, 'admin deletes the completed snapshot as a whole';
  reset role;
  select count(*) into n from public.repository_snapshot_sources where snapshot_id = s_done; assert n = 0, 'its source record cascades';

  raise notice 'ALL SNAPSHOT SOURCE CHECKS PASSED';
end;
$$;

rollback;
