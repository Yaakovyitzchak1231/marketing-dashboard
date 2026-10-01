-- 005_rls_pre_existing_tables.sql
--
-- Records the RLS that already protects four tables but that no committed
-- migration ever created.
--
-- Provenance
-- ----------
-- These policies exist on the live database and were applied on 2026-09-30
-- from supabase/migrations/002_enable_rls.sql. That file was never committed:
-- it survives only in two dead worktrees (.worktrees/rls and
-- .worktrees/t10-deploy), so the migrations on main never contained them.
-- 001 only creates the tables; 002_unified_model and 003_corrective_delta
-- scope the v2 tables (domains, inboxes, ideas, costs, angles) but never touch
-- campaigns, daily_metrics, accounts or collection_runs.
--
-- Why that matters
-- ---------------
-- Rebuilding this project from supabase/migrations/ alone would create four
-- tables with RLS switched OFF and no policy at all. Every table in this
-- schema relies on the anon role being blocked by policy rather than by grant,
-- so that rebuild would publish the whole collector inventory to anyone holding
-- the publishable anon key, which ships to every browser.
--
-- Reconciliation with 004_security_hardening.sql
-- ----------------------------------------------
-- The live `collection_runs` read policy is NOT the one 002_enable_rls created.
-- It was found world-readable on 2026-10-01: a `USING (true)` policy naming
-- {anon, authenticated}, which 004 replaced with an email-scoped policy named
-- `authenticated_read`. Both are email-scoped SELECT policies for the same
-- role, so they agree; but Postgres permits two policies with different names
-- on one table, so leaving both would accumulate duplicates on every re-run.
-- Step 2 therefore drops `authenticated_read` on collection_runs as well, which
-- makes this file converge to exactly one read policy whether it lands on a
-- fresh rebuild (004 then 005) or on the live database (004 already applied).
--
-- Measured live before writing this, as the owner:
--   pg_policies, policyname LIKE 'jacob reads%'
--     accounts        SELECT  {authenticated}
--     campaigns       SELECT  {authenticated}
--     daily_metrics   SELECT  {authenticated}
--     collection_runs -- absent; 004 recreated it as `authenticated_read`
--
-- Re-runnable: every policy is preceded by DROP POLICY IF EXISTS and the ALTERs
-- are idempotent.

-- ---------------------------------------------------------------------------
-- 1. Enable RLS on the four pre-existing collector tables.
-- ---------------------------------------------------------------------------
ALTER TABLE public.campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_metrics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_runs ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 2. Drop any prior version of these named policies so re-running is clean.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS "jacob reads campaigns"       ON public.campaigns;
DROP POLICY IF EXISTS "jacob reads daily_metrics"   ON public.daily_metrics;
DROP POLICY IF EXISTS "jacob reads accounts"        ON public.accounts;
DROP POLICY IF EXISTS "jacob reads collection_runs" ON public.collection_runs;
-- 004 named collection_runs' read policy `authenticated_read`. Drop it too so
-- this file leaves exactly one read policy on that table either way.
DROP POLICY IF EXISTS "authenticated_read"          ON public.collection_runs;

-- ---------------------------------------------------------------------------
-- 3. SELECT for authenticated only, scoped to Jacob.
--
--    No policy is created for `anon`. RLS narrows ROWS while the underlying
--    GRANT decides whether a role can reach the table at all, so the block on
--    anon rests on the absence of a matching policy, not on a missing grant.
--    Verified live: anon still holds full DML privileges on all four tables
--    (information_schema.role_table_grants returns DELETE, INSERT, REFERENCES,
--    SELECT, TRIGGER, TRUNCATE, UPDATE), and with RLS on every one of those
--    statements returns zero rows or a policy-violation error. service_role
--    bypasses RLS by design and must never appear in a read path.
-- ---------------------------------------------------------------------------

-- campaigns: single-tenant inventory. campaigns has no owner column, so the
-- email check is the ownership gate rather than a per-row comparison.
CREATE POLICY "jacob reads campaigns" ON public.campaigns
  FOR SELECT TO authenticated
  USING (auth.email() = 'yaakovytroutai@gmail.com');

-- daily_metrics: child of campaigns. Scope through the parent so a policy that
-- walks the relationship cannot leak across owners if a second tenant is ever
-- added.
CREATE POLICY "jacob reads daily_metrics" ON public.daily_metrics
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.campaigns c
      WHERE c.id = daily_metrics.campaign_id
        AND auth.email() = 'yaakovytroutai@gmail.com'
    )
  );

-- accounts: account-wide rollup, single-tenant like campaigns.
CREATE POLICY "jacob reads accounts" ON public.accounts
  FOR SELECT TO authenticated
  USING (auth.email() = 'yaakovytroutai@gmail.com');

-- collection_runs: pipeline run log. It has no campaign_id column and holds no
-- per-tenant data, so it is scoped directly by the authenticated user rather
-- than through a subquery. Do NOT widen this to `USING (true)` or add anon:
-- 004_security_hardening.sql documents that doing so exposed all 67 collector
-- rows to anyone holding the publishable anon key.
CREATE POLICY "jacob reads collection_runs" ON public.collection_runs
  FOR SELECT TO authenticated
  USING (auth.email() = 'yaakovytroutai@gmail.com');

-- ---------------------------------------------------------------------------
-- 4. Grants.
--
--    This block is a no-op on the live database and is recorded here only
--    because it is part of the provenance of these policies. Measured live:
--    authenticated already holds SELECT on all four tables, and so does anon.
--    Narrowing anon to SELECT only would be a second independent lock, but it
--    changes the live grant surface the collector's write path depends on, so
--    it is deliberately not done here.
-- ---------------------------------------------------------------------------
GRANT SELECT ON public.campaigns, public.daily_metrics, public.accounts, public.collection_runs TO authenticated;
