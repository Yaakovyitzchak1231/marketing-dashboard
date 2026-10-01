-- 004_security_hardening.sql
--
-- Two real exposure findings, verified against the live database on
-- 2026-10-01. Both widen read access beyond what the repo intended, and both
-- were contradicted by the live schema rather than by the migrations.
--
-- 1. collection_runs was world-readable.
--    An anonymous request using only the publishable anon key — which ships to
--    every browser — returned 67 rows from collection_runs, exposing
--    ran_at, ok, api_calls, campaigns_collected, campaigns_persisted, stages
--    and errors for every collector. 002's own comment states that reads must
--    be authenticated-only and warns against USING (true), but neither 002 nor
--    003 ever enabled RLS on this table or replaced its policies. The four
--    pre-existing tables were described as already protected; this one was not.
--
-- 2. The manual-entry write policies were FOR ALL.
--    ideas_write / costs_write / angles_write were created FOR ALL TO
--    authenticated USING (true) WITH CHECK (true). A FOR ALL policy applies its
--    USING clause to SELECT as well as INSERT/UPDATE/DELETE, and Postgres ORs
--    multiple permissive policies together rather than intersecting them. So
--    those policies silently granted every authenticated user a read of every
--    row, overriding the email-scoped authenticated_read policy that was
--    created alongside them to restrict reads to Jacob.
--
-- Every statement is idempotent.

-- ---------------------------------------------------------------------------
-- 1. Close the anonymous read on collection_runs.
--    Enable RLS (no-op if already on) and drop any permissive policy so the
--    only remaining path is an authenticated, email-scoped read. Collector
--    writes use the service_role key, which bypasses RLS and is unaffected.
-- ---------------------------------------------------------------------------
ALTER TABLE collection_runs ENABLE ROW LEVEL SECURITY;

DO $$
DECLARE p record;
BEGIN
    FOR p IN
        SELECT policyname FROM pg_policies
        WHERE schemaname = 'public' AND tablename = 'collection_runs'
    LOOP
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.collection_runs', p.policyname);
    END LOOP;

    -- Recreate the same email-scoped read the other collector tables use.
    -- Uses auth.jwt() ->> 'email' rather than auth.email(): both work, but the
    -- jwt form reads the claim the session actually carries, which is what the
    -- dashboard's own sign-in issues.
    EXECUTE format(
        'CREATE POLICY authenticated_read ON public.collection_runs
           FOR SELECT TO authenticated
           USING (auth.jwt() ->> ''email'' = %L)',
        'yaakovytroutai@gmail.com');
END $$;

-- ---------------------------------------------------------------------------
-- 2. Narrow the manual-entry policies to writes only.
--    Dropping the FOR ALL policies and recreating them as FOR INSERT / FOR
--    UPDATE keeps manual entry working for the signed-in dashboard user while
--    removing the SELECT side effect that overrode the email-scoped read.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS ideas_write ON public.ideas;
DROP POLICY IF EXISTS costs_write ON public.costs;
DROP POLICY IF EXISTS angles_write ON public.angles;

-- Manual entry from the dashboard UI: the signed-in user may add and edit
-- their own ideas, costs and angles. Reads stay governed by the
-- email-scoped authenticated_read policy above.
CREATE POLICY ideas_insert ON ideas
    FOR INSERT TO authenticated WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
CREATE POLICY ideas_update ON ideas
    FOR UPDATE TO authenticated USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

CREATE POLICY costs_insert ON costs
    FOR INSERT TO authenticated WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
CREATE POLICY costs_update ON costs
    FOR UPDATE TO authenticated USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

CREATE POLICY angles_insert ON angles
    FOR INSERT TO authenticated WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
CREATE POLICY angles_update ON angles
    FOR UPDATE TO authenticated USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
