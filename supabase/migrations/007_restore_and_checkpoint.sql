-- 007_restore_and_checkpoint.sql
--
-- 006 stores the revision timeline as metadata only: who, what kind, when.
-- There is no row snapshot, so "restore to revision N" has nothing to write
-- back. This migration adds the two interactivity features that metadata
-- alone cannot express:
--
--   1. snapshot jsonb on revisions — the business columns of the row as they
--      stood at that revision, captured by the write path. Restore reads this
--      and rewrites the live row, then records a NEW revision (change_kind
--      'restore') stamped with the restoring actor — never the original
--      author, because copying the old audit columns would claim that author
--      wrote again.
--
--   2. checkpoints — a named capture of the current heads (per-object latest
--      revision), one of which is the default the workspace opens. Save and
--      Pin are distinct actions; a checkpoint whose name is not given uses a
--      timestamp (set in the app layer), never a composed marketing title.
--
-- All statements are additive and idempotent.

-- ---------------------------------------------------------------------------
-- 1. Row snapshot on the timeline.
--    NULL means "no snapshot was recorded" (true for baseline rows written
--    before 007, and for delete revisions, where the row no longer exists).
--    Never backfilled with the current live row: the current row is not
--    necessarily the row that revision described.
-- ---------------------------------------------------------------------------
ALTER TABLE revisions ADD COLUMN IF NOT EXISTS snapshot jsonb;

-- ---------------------------------------------------------------------------
-- 2. Admit 'restore' as a change kind on the timeline and on the three live
--    tables' audit columns. Restore is a distinct kind, not a disguised
--    'update': it says "this write came from rolling the row back to an
--    earlier revision", which an 'update' would lie about.
-- ---------------------------------------------------------------------------
ALTER TABLE revisions DROP CONSTRAINT IF EXISTS revisions_change_kind_check;
ALTER TABLE revisions ADD CONSTRAINT revisions_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline', 'restore'));

ALTER TABLE ideas DROP CONSTRAINT IF EXISTS ideas_change_kind_check;
ALTER TABLE ideas ADD CONSTRAINT ideas_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline', 'restore'));

ALTER TABLE costs DROP CONSTRAINT IF EXISTS costs_change_kind_check;
ALTER TABLE costs ADD CONSTRAINT costs_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline', 'restore'));

ALTER TABLE angles DROP CONSTRAINT IF EXISTS angles_change_kind_check;
ALTER TABLE angles ADD CONSTRAINT angles_change_kind_check
    CHECK (change_kind IS NULL OR change_kind IN ('create', 'update', 'delete', 'baseline', 'restore'));

-- ---------------------------------------------------------------------------
-- 3. Checkpoints: named captures of current heads.
--    heads is a jsonb array of { artifact_type, artifact_id, revision_number },
--    one entry per object, the object's latest revision at capture time.
--    actor is NULL when the source did not say who saved it.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkpoints (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name text NOT NULL,
    actor text,
    heads jsonb NOT NULL DEFAULT '[]'::jsonb,
    is_default boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- At most one checkpoint is the default. A partial unique index over the rows
-- where is_default is true enforces this in the schema, not in app code.
CREATE UNIQUE INDEX IF NOT EXISTS checkpoints_one_default
    ON checkpoints (is_default) WHERE is_default = true;

ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;

-- Same single-owner gate as 004/006. No anon policy, no public scope.
DROP POLICY IF EXISTS authenticated_read ON checkpoints;
CREATE POLICY authenticated_read ON checkpoints
    FOR SELECT TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS checkpoints_insert ON checkpoints;
CREATE POLICY checkpoints_insert ON checkpoints
    FOR INSERT TO authenticated
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS checkpoints_update ON checkpoints;
CREATE POLICY checkpoints_update ON checkpoints
    FOR UPDATE TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
