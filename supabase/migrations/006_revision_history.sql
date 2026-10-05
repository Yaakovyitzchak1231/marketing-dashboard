-- 006_revision_history.sql
--
-- Sequence choice, recorded in 002_unified_model.sql and repeated here:
--   001 creates tables -> 002 audits the three editable objects.
--
-- 001 -> 002 -> 003 -> 004 -> 005 is the proven live history. This file does
-- not rewrite those migrations. It repeats 002's audit ALTERs with
-- ADD COLUMN IF NOT EXISTS so a database that already applied 002 (and will
-- not re-run the appended block) still gains the columns. Fresh replays that
-- already ran the 002 block no-op here.
--
-- revisions is the single timeline the view reads. RLS matches the existing
-- single-owner email gate. No anon policy, no public scope, no new grant.
-- NULL actor / change_message means the source did not say.
--
-- The data assignment is the same statement list as scripts/backfill_revisions.sql
-- so `supabase db push` backfills, and the script can be re-run once by hand.

ALTER TABLE ideas ADD COLUMN IF NOT EXISTS revision_id uuid;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS revision_number int;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS change_kind text;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS change_message text;
ALTER TABLE ideas ADD COLUMN IF NOT EXISTS actor text;

ALTER TABLE costs ADD COLUMN IF NOT EXISTS revision_id uuid;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS revision_number int;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS change_kind text;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS change_message text;
ALTER TABLE costs ADD COLUMN IF NOT EXISTS actor text;

ALTER TABLE angles ADD COLUMN IF NOT EXISTS revision_id uuid;
ALTER TABLE angles ADD COLUMN IF NOT EXISTS revision_number int;
ALTER TABLE angles ADD COLUMN IF NOT EXISTS change_kind text;
ALTER TABLE angles ADD COLUMN IF NOT EXISTS change_message text;
ALTER TABLE angles ADD COLUMN IF NOT EXISTS actor text;

CREATE TABLE IF NOT EXISTS revisions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_type text NOT NULL,
    artifact_id uuid NOT NULL,
    revision_number int NOT NULL,
    actor text,
    change_kind text,
    change_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_type, artifact_id, revision_number)
);

ALTER TABLE revisions DROP CONSTRAINT IF EXISTS revisions_artifact_type_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_artifact_type_check
    CHECK (artifact_type IN ('ideas', 'costs', 'angles'));

ALTER TABLE revisions DROP CONSTRAINT IF EXISTS revisions_change_kind_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline'));

ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_change_kind_check;
ALTER TABLE ideas ADD CONSTRAINT ideas_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline'));

ALTER TABLE costs DROP CONSTRAINT IF EXISTS costs_change_kind_check;
ALTER TABLE costs ADD CONSTRAINT costs_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline'));

ALTER TABLE angles DROP CONSTRAINT IF EXISTS angles_change_kind_check;
ALTER TABLE angles ADD CONSTRAINT angles_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline'));

ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_revision_number_check;
ALTER TABLE ideas ADD CONSTRAINT ideas_revision_number_check
    CHECK (revision_number IS NULL OR revision_number >= 1);

ALTER TABLE costs DROP CONSTRAINT IF EXISTS costs_revision_number_check;
ALTER TABLE costs ADD CONSTRAINT costs_revision_number_check
    CHECK (revision_number IS NULL OR revision_number >= 1);

ALTER TABLE angles DROP CONSTRAINT IF EXISTS angles_revision_number_check;
ALTER TABLE angles ADD CONSTRAINT angles_revision_number_check
    CHECK (revision_number IS NULL OR revision_number >= 1);

CREATE INDEX IF NOT EXISTS idx_revisions_artifact_created
    ON revisions (artifact_type, artifact_id, created_at);

ALTER TABLE revisions ENABLE ROW LEVEL SECURITY;

-- Same single-owner gate as 004. jwt email is the claim the dashboard session
-- carries. No policy for anon. service_role bypasses RLS and is not granted here.
DROP POLICY IF EXISTS authenticated_read ON revisions;
CREATE POLICY authenticated_read ON revisions
    FOR SELECT TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS revisions_insert ON revisions;
CREATE POLICY revisions_insert ON revisions
    FOR INSERT TO authenticated
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS revisions_update ON revisions;
CREATE POLICY revisions_update ON revisions
    FOR UPDATE TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

-- Backfill. Same assignment as scripts/backfill_revisions.sql.
-- revision_number starting at 1, ordered by created_at. actor stays NULL.

UPDATE ideas AS i
SET
    revision_id = COALESCE(i.revision_id, gen_random_uuid()),
    revision_number = 1,
    change_kind = COALESCE(i.change_kind, 'baseline')
FROM (
    SELECT id
    FROM ideas
    WHERE revision_number IS NULL
    ORDER BY created_at, id
) AS ordered
WHERE i.id = ordered.id
  AND i.revision_number IS NULL;

UPDATE costs AS c
SET
    revision_id = COALESCE(c.revision_id, gen_random_uuid()),
    revision_number = 1,
    change_kind = COALESCE(c.change_kind, 'baseline')
FROM (
    SELECT id
    FROM costs
    WHERE revision_number IS NULL
    ORDER BY created_at, id
) AS ordered
WHERE c.id = ordered.id
  AND c.revision_number IS NULL;

UPDATE angles AS a
SET
    revision_id = COALESCE(a.revision_id, gen_random_uuid()),
    revision_number = 1,
    change_kind = COALESCE(a.change_kind, 'baseline')
FROM (
    SELECT id
    FROM angles
    WHERE revision_number IS NULL
    ORDER BY created_at, id
) AS ordered
WHERE a.id = ordered.id
  AND a.revision_number IS NULL;

INSERT INTO revisions (
    id, artifact_type, artifact_id, revision_number,
    actor, change_kind, change_message, created_at
)
SELECT
    i.revision_id, 'ideas', i.id, i.revision_number,
    i.actor, i.change_kind, i.change_message, i.created_at
FROM ideas i
WHERE i.revision_id IS NOT NULL
  AND i.revision_number IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM revisions r
      WHERE r.artifact_type = 'ideas'
        AND r.artifact_id = i.id
        AND r.revision_number = i.revision_number
  )
ORDER BY i.created_at, i.id;

INSERT INTO revisions (
    id, artifact_type, artifact_id, revision_number,
    actor, change_kind, change_message, created_at
)
SELECT
    c.revision_id, 'costs', c.id, c.revision_number,
    c.actor, c.change_kind, c.change_message, c.created_at
FROM costs c
WHERE c.revision_id IS NOT NULL
  AND c.revision_number IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM revisions r
      WHERE r.artifact_type = 'costs'
        AND r.artifact_id = c.id
        AND r.revision_number = c.revision_number
  )
ORDER BY c.created_at, c.id;

INSERT INTO revisions (
    id, artifact_type, artifact_id, revision_number,
    actor, change_kind, change_message, created_at
)
SELECT
    a.revision_id, 'angles', a.id, a.revision_number,
    a.actor, a.change_kind, a.change_message, a.created_at
FROM angles a
WHERE a.revision_id IS NOT NULL
  AND a.revision_number IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM revisions r
      WHERE r.artifact_type = 'angles'
        AND r.artifact_id = a.id
        AND r.revision_number = a.revision_number
  )
ORDER BY a.created_at, a.id;
