-- Phase 1 (authorization foundation) grant audit, 2026-10-18. Revokes only; no table, column, row or policy changes.
--
-- Found: public.profiles kept Supabase's default table grants that 20261007000001 did not revoke
-- (it revoked only INSERT/UPDATE/DELETE):
--   anon:          SELECT, TRUNCATE, REFERENCES, TRIGGER
--   authenticated: TRUNCATE, REFERENCES, TRIGGER
-- RLS limited the SELECT to nothing for anon, but TRUNCATE is not subject to RLS, and no client needs TRIGGER or
-- REFERENCES. The SECURITY DEFINER trigger functions handle_new_user() and handle_user_email_change() were executable
-- by PUBLIC (default). Calling them outside a trigger fails, so this was hygiene, not a reachable exploit; trigger
-- firing does not check EXECUTE, so sign-up and email sync keep working.
--
-- Every later table already revokes these grants explicitly. supabase/tests/privilege_grants_rls.sql asserts the
-- result for every application table and SECURITY DEFINER function, so a future table that forgets is caught.
--
-- Rollback (restores the previous grants exactly):
--   grant select, truncate, references, trigger on public.profiles to anon;
--   grant truncate, references, trigger on public.profiles to authenticated;
--   grant execute on function public.handle_new_user(), public.handle_user_email_change() to public;

revoke all on public.profiles from anon;
revoke truncate, references, trigger on public.profiles from authenticated;

revoke all on function public.handle_new_user() from public, anon, authenticated;
revoke all on function public.handle_user_email_change() from public, anon, authenticated;
