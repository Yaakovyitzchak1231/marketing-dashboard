-- 003_corrective_delta.sql
--
-- The 002 migration applied to the live database was a stale copy that used
-- CREATE TABLE IF NOT EXISTS for collection_runs (a no-op: the table already
-- existed without the collector column) and created overly permissive
-- anon+authenticated read policies. This delta brings the live schema to the
-- state 002 in the repo intends. All statements are idempotent.

-- 1. collection_runs: add the collector column + unique index the v2
--    collectors upsert against.
ALTER TABLE collection_runs
    ADD COLUMN IF NOT EXISTS collector text NOT NULL DEFAULT 'instantly';
CREATE UNIQUE INDEX IF NOT EXISTS idx_collection_runs_collector_ran_at
    ON collection_runs (collector, ran_at);

-- 2. Replace the stale permissive read policies (anon + authenticated,
--    USING (true)) with the repo-intended email-scoped authenticated reads.
DO $$
DECLARE t text;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'ideas','channels','angles','angle_daily_metrics','leads',
        'verification_runs','domains','inboxes','costs'
    ] LOOP
        EXECUTE format('DROP POLICY IF EXISTS authenticated_read ON %I', t);
        EXECUTE format(
            'CREATE POLICY authenticated_read ON %I FOR SELECT TO authenticated USING (auth.email() = %L)',
            t, 'yaakovytroutai@gmail.com');
    END LOOP;
END $$;
