-- 002_enable_rls.sql
-- Row-level security for the marketing dashboard.
--
-- Before this migration every table was world-readable through PostgREST using
-- nothing but the publishable (anon) key, which ships to every browser. Any
-- visitor could read emails_sent, opportunity_value and the whole campaign
-- inventory without logging in.
--
-- After this migration:
--   * anon        -> zero rows (no policy targets the anon role)
--   * authenticated -> rows, but only for Jacob
--   * service_role -> unchanged; it bypasses RLS by design and must never be
--                     used in a read path
--
-- Re-runnable: policy creation is preceded by DROP POLICY IF EXISTS and the
-- ALTERs are idempotent, so applying this file twice is a no-op.
--
-- APPLIED AND VERIFIED against project zlbxjdueuhinywnovyoe on 2026-09-30.
-- `select tablename, rowsecurity from pg_tables where schemaname='public'`
-- returned rowsecurity = true for all four. pg_policies returned exactly these
-- four policies, every one of them `roles = {authenticated}, cmd = SELECT`, and
-- no policy of any kind for anon.

-- 1. Enable RLS on all four tables -----------------------------------------
ALTER TABLE public.campaigns       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.daily_metrics   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounts        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.collection_runs ENABLE ROW LEVEL SECURITY;

-- 2. Drop any prior version of these policies so re-running is clean ------
DROP POLICY IF EXISTS "jacob reads campaigns"       ON public.campaigns;
DROP POLICY IF EXISTS "jacob reads daily_metrics"   ON public.daily_metrics;
DROP POLICY IF EXISTS "jacob reads accounts"        ON public.accounts;
DROP POLICY IF EXISTS "jacob reads collection_runs" ON public.collection_runs;

-- 3. Policies: SELECT for authenticated only, scoped to Jacob ---------------

-- campaigns: single-tenant inventory. Every row is his; the email check is the
-- ownership gate, not a per-row column (campaigns has no owner column).
CREATE POLICY "jacob reads campaigns" ON public.campaigns
  FOR SELECT TO authenticated
  USING (auth.email() = 'yaakovytroutai@gmail.com');

-- daily_metrics: child of campaigns, so scope through the parent to avoid a
-- policy that would leak across owners if a second tenant ever existed.
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

-- collection_runs: pipeline run log. It has NO campaign_id column (verified
-- against information_schema) and holds no per-tenant data, so it is scoped
-- by the authenticated user directly rather than through a subquery.
CREATE POLICY "jacob reads collection_runs" ON public.collection_runs
  FOR SELECT TO authenticated
  USING (auth.email() = 'yaakovytroutai@gmail.com');

-- 4. No policy is created for `anon`. With RLS enabled and no anon policy,
--    PostgREST returns [] for every table in section 1.

-- 5. Table grants.
--
--    RLS narrows ROWS; the underlying GRANT decides whether a role can reach the
--    table at all. So the block on anon rests entirely on the policy, not on a
--    missing grant. That is deliberate and it is verified: anon still holds full
--    DML table grants on all four tables (measured in
--    information_schema.role_table_grants), and with RLS on, every one of those
--    statements is denied:
--
--      SELECT   -> 200 []                       (no policy matches anon)
--      INSERT   -> 42501 "new row violates row-level security policy"
--      UPDATE   -> 200 [] with Prefer: return=representation (0 rows touched)
--      DELETE   -> 200 [] with Prefer: return=representation (0 rows touched)
--
--    Narrowing anon to SELECT only would be a second, independent lock, and
--    this card does not do it: it is a change to the live grant surface, the
--    collector's write path deserves its own test, and RLS has already closed the
--    hole. Worth doing as a follow-up -- see the note in the completion handoff.
GRANT SELECT ON public.campaigns, public.daily_metrics, public.accounts, public.collection_runs TO authenticated;

-- Verification queries (run separately, not part of the migration):
--
--   select tablename, rowsecurity from pg_tables where schemaname = 'public';
--   select policyname, roles::text, cmd from pg_policies
--     where schemaname = 'public' order by tablename;
--
--   -- must be blocked:
--   curl -H "apikey: $SUPABASE_PUBLISHABLE_KEY" \
--        "$NEXT_PUBLIC_SUPABASE_URL/rest/v1/accounts?select=*"   # -> []
