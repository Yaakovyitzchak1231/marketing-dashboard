-- 007_collaboration_store.sql
--
-- Approvals, comments, and restore/pin checkpoints. Read-only provenance
-- surface on the shared workspace: same single-owner RLS gate, no anon
-- policy, no public scope, no multi-user grants. Every row is an audit
-- record with creator + ts; a NULL means the source did not say.
--
-- These are the store tables the collaboration surface reads and writes.
-- Nothing here widens access: authenticated users reach the tables only
-- through the same single-owner email gate as the editable objects.

-- === approvals ============================================================
CREATE TABLE IF NOT EXISTS approvals (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_type text NOT NULL,
    artifact_id uuid NOT NULL,
    actor text,
    status text NOT NULL DEFAULT 'requested',
    owner text,
    reason text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_type, artifact_id, status)
);

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_artifact_type_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_artifact_type_check
    CHECK (artifact_type IN ('ideas', 'costs', 'angles'));

ALTER TABLE approvals DROP CONSTRAINT IF EXISTS approvals_status_check;
ALTER TABLE approvals ADD CONSTRAINT approvals_status_check
    CHECK (status IN ('requested', 'approved', 'dismissed'));

CREATE INDEX IF NOT EXISTS idx_approvals_artifact
    ON approvals (artifact_type, artifact_id, created_at);

ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;

-- Same single-owner gate as 004/005/006. Anon sees nothing, never a policy.
DROP POLICY IF EXISTS approvals_authenticated_read ON approvals;
CREATE POLICY approvals_authenticated_read
    ON approvals FOR SELECT TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS approvals_insert ON approvals;
CREATE POLICY approvals_insert
    ON approvals FOR INSERT TO authenticated
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS approvals_update ON approvals;
CREATE POLICY approvals_update
    ON approvals FOR UPDATE TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com')
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

-- === comments =============================================================
CREATE TABLE IF NOT EXISTS comments (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_type text NOT NULL,
    artifact_id uuid NOT NULL,
    row_name text NOT NULL,
    text text NOT NULL,
    author text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (artifact_type, artifact_id, row_name, created_at)
);

ALTER TABLE comments DROP CONSTRAINT IF EXISTS comments_artifact_type_check;
ALTER TABLE comments ADD CONSTRAINT comments_artifact_type_check
    CHECK (artifact_type IN ('ideas', 'costs', 'angles'));

CREATE INDEX IF NOT EXISTS idx_comments_artifact
    ON comments (artifact_type, artifact_id, created_at);

ALTER TABLE comments ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS comments_authenticated_read ON comments;
CREATE POLICY comments_authenticated_read
    ON comments FOR SELECT TO authenticated
    USING (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');

DROP POLICY IF EXISTS comments_insert ON comments;
CREATE POLICY comments_insert
    ON comments FOR INSERT TO authenticated
    WITH CHECK (auth.jwt() ->> 'email' = 'yaakovytroutai@gmail.com');
