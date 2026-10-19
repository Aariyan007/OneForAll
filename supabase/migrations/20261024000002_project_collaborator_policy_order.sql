-- Performance fix for the collaborating-team project policy of migration 20261024000001.
--
-- Permissive policies are OR'ed; the planner kept the policy order it was given, and with the original name
-- ("projects_select_collaborating_team") the SECURITY DEFINER call public.is_project_collaborator(id) ran FIRST for
-- every project row checked. Reads that check project visibility per row (for example repository_files under
-- repository_graph_overview(), 2,475 files) then paid the definer call every time: the overview of the real
-- 13,506-symbol analysis took 7.5-8.1 s (statement timeout 8 s) against 3.7 s without the policy.
-- Renamed so it is evaluated after projects_select_admin_or_team_member: the definer function now runs only when the
-- owner/admin/team-member check fails (measured: 4.0 s, the pre-existing cost). Same rule, same access.

drop policy if exists "projects_select_collaborating_team" on public.projects;

create policy "projects_select_access_via_collaborating_team" on public.projects for select to authenticated
  using (public.is_project_collaborator(id));
