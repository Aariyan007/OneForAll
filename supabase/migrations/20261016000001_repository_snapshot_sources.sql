-- Repository snapshot sources: where a snapshot's source came from, and how far it is verified.
--
-- Additive only. One row per snapshot, written by the server-side archive ingestion (OWNER/ADMIN, while the snapshot
-- is still being built) and immutable afterwards. The source code itself is never stored here or anywhere else:
-- the uploaded archive lives only in the memory of the request that processes it.
--
-- Verification: an uploaded archive is NOT proof of the repository contents at the snapshot's commit. Today the only
-- allowed value is UNVERIFIED. `archive_commit` is the commit id the archive itself claims (for example the ZIP
-- comment written by `git archive` / Git host downloads); it is recorded as a claim, never as verification. A future
-- provider-based ingestion can add new `source_kind` / `verification` values in a later additive migration.

create table public.repository_snapshot_sources (
  snapshot_id    uuid primary key references public.repository_snapshots (id) on delete cascade,
  source_kind    text not null check (source_kind in ('UPLOADED_ARCHIVE')),
  verification   text not null default 'UNVERIFIED' check (verification in ('UNVERIFIED')),
  archive_format text not null check (archive_format in ('ZIP')),
  archive_sha256 text not null check (archive_sha256 ~ '^[0-9a-f]{64}$'),
  archive_bytes  bigint not null check (archive_bytes > 0),
  archive_commit text check (archive_commit ~ '^([0-9a-f]{40}|[0-9a-f]{64})$'),
  entries_total  integer not null check (entries_total >= 0),
  files_accepted integer not null check (files_accepted >= 0),
  files_skipped  integer not null check (files_skipped >= 0),
  uploaded_by    uuid references auth.users (id) on delete set null,
  created_at     timestamptz not null default now(),

  constraint repository_snapshot_sources_counts check (files_accepted + files_skipped <= entries_total)
);

alter table public.repository_snapshot_sources enable row level security;

-- SELECT: exactly when the parent snapshot is visible (snapshot RLS: OWNER/ADMIN or member of the project's team).
create policy "repository_snapshot_sources_select_snapshot_visible"
  on public.repository_snapshot_sources for select
  to authenticated
  using (exists (
    select 1 from public.repository_snapshots s where s.id = repository_snapshot_sources.snapshot_id
  ));

-- INSERT/DELETE: OWNER/ADMIN of the derived organization, only while the snapshot is being built (PENDING or
-- PROCESSING), exactly like the file manifest. The uploader is always the signed-in user. A COMPLETED snapshot's
-- source record is frozen; a FAILED snapshot is retried by moving it back to PENDING first.
create policy "repository_snapshot_sources_insert_admin"
  on public.repository_snapshot_sources for insert
  to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and exists (
      select 1
      from public.repository_snapshots s
      join public.repositories r on r.id = s.repository_id
      join public.projects p on p.id = r.project_id
      join public.teams t on t.id = p.team_id
      join public.departments d on d.id = t.department_id
      where s.id = repository_snapshot_sources.snapshot_id
        and s.status in ('PENDING', 'PROCESSING')
        and public.has_org_role(d.organization_id, array['OWNER', 'ADMIN'])
    )
  );

create policy "repository_snapshot_sources_delete_admin"
  on public.repository_snapshot_sources for delete
  to authenticated
  using (exists (
    select 1
    from public.repository_snapshots s
    join public.repositories r on r.id = s.repository_id
    join public.projects p on p.id = r.project_id
    join public.teams t on t.id = p.team_id
    join public.departments d on d.id = t.department_id
    where s.id = repository_snapshot_sources.snapshot_id
      and s.status in ('PENDING', 'PROCESSING')
      and public.has_org_role(d.organization_id, array['OWNER', 'ADMIN'])
  ));

-- Immutable once written: no update grant and no update policy. `verification` and `created_at` are not insertable
-- by clients, so a client can never record anything but the default UNVERIFIED.
revoke all on public.repository_snapshot_sources from anon, authenticated;
grant select on public.repository_snapshot_sources to authenticated;
grant insert (snapshot_id, source_kind, archive_format, archive_sha256, archive_bytes, archive_commit,
              entries_total, files_accepted, files_skipped, uploaded_by)
  on public.repository_snapshot_sources to authenticated;
grant delete on public.repository_snapshot_sources to authenticated;
