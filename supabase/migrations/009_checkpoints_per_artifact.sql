-- 009_checkpoints_per_artifact.sql
--
-- The live checkpoints table predates the collab surface (id, name, actor,
-- heads jsonb, is_default, created_at) and has no per-artifact columns, so
-- GET /api/checkpoints?artifact_type=&artifact_id= 500s on every call:
-- checkpoints.artifact_type does not exist.
--
-- Additive fix only: new nullable columns + index + RLS policies. No column
-- is renamed or dropped, no existing row is touched. Same single-owner gate
-- as 004/005/006/008 — authenticated owner only, anon sees nothing.

ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS artifact_type text;
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS artifact_id uuid;
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS revision_number integer;
ALTER TABLE checkpoints ADD COLUMN IF NOT EXISTS snapshot jsonb;

ALTER TABLE checkpoints DROP CONSTRAINT IF EXISTS checkpoints_artifact_type_check;
ALTER TABLE checkpoints ADD CONSTRAINT checkpoints_artifact_type_check
    CHECK (artifact_type IS NULL OR artifact_type IN ('ideas', 'costs', 'angles'));

CREATE INDEX IF NOT EXISTS idx_checkpoints_artifact
    ON checkpoints (artifact_type, artifact_id, created_at);

ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS checkpoints_authenticated_read ON checkpoints;
CREATE POLICY checkpoints_authenticated_read
    ON checkpoints FOR SELECT TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS checkpoints_insert ON checkpoints;
CREATE POLICY checkpoints_insert
    ON checkpoints FOR INSERT TO authenticated
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS checkpoints_update ON checkpoints;
CREATE POLICY checkpoints_update
    ON checkpoints FOR UPDATE TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
