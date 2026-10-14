-- Exclusion breakdown for uploaded source archives. Additive and backward-compatible.
--
-- `files_skipped` already records how many files of the archive were not recorded in the manifest. These columns say
-- why, one category per file:
--   files_skipped_oversized  larger than the per-file limit (never decompressed, truncated or parsed)
--   files_skipped_generated  inside an ignored generated/dependency folder (node_modules, .git, dist, build, .next, coverage)
--   files_skipped_metadata   archive-tool metadata (__MACOSX/)
-- All three are NULL for rows written before this migration ("not recorded", never shown as zero). When present they
-- are all present and add up exactly to files_skipped. Rows stay immutable (no update grant), as before.

alter table public.repository_snapshot_sources
  add column files_skipped_oversized integer check (files_skipped_oversized >= 0),
  add column files_skipped_generated integer check (files_skipped_generated >= 0),
  add column files_skipped_metadata  integer check (files_skipped_metadata >= 0),
  add constraint repository_snapshot_sources_exclusion_breakdown check (
    (files_skipped_oversized is null and files_skipped_generated is null and files_skipped_metadata is null)
    or (
      files_skipped_oversized is not null and files_skipped_generated is not null and files_skipped_metadata is not null
      and files_skipped_oversized + files_skipped_generated + files_skipped_metadata = files_skipped
    )
  );

grant insert (files_skipped_oversized, files_skipped_generated, files_skipped_metadata)
  on public.repository_snapshot_sources to authenticated;
