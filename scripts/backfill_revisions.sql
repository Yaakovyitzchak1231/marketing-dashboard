-- One-time backfill for revision history.
--
-- Requires the audit columns and the revisions table (006_revision_history.sql
-- applies this same assignment on migrate). Safe to re-run: only rows whose
-- revision_number IS NULL are stamped, and timeline rows are inserted only
-- when that (artifact, revision_number) is not already stored.
--
-- Assigns revision_number starting at 1, ordered by created_at.
-- Each existing row is revision 1 of that artifact. ORDER BY created_at makes
-- the walk deterministic and is the timeline order (revisions.created_at
-- copies the stored created_at). It does not number artifacts against each
-- other: the second-created idea is not revision 2. The source did not say that.
--
-- actor is left NULL. NULL means the source did not say who wrote the row.
-- change_kind 'baseline' is this script's own fact, not a guess about the
-- original writer. change_message stays NULL.

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
