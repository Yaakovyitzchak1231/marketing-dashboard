import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 007 adds the two interactivity features to the 006 data model:
 *   - revisions.snapshot (jsonb) so a restore has something to write back
 *   - a checkpoints table (heads + is_default) for save/pin
 *   - 'restore' admitted as a change_kind on revisions and the three tables
 * These assertions parse the committed SQL — no live database is assumed.
 */

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase/migrations')

function migration(name: string): string {
  return readFileSync(join(MIGRATIONS, name), 'utf8')
}

describe('007 restore and checkpoint schema', () => {
  it('adds a jsonb snapshot column to revisions', () => {
    const sql = migration('007_restore_and_checkpoint.sql')
    expect(sql).toMatch(/ALTER TABLE\s+revisions\s+ADD COLUMN\s+IF\s+NOT\s+EXISTS\s+snapshot\s+jsonb/i)
  })

  it('creates a checkpoints table with heads and is_default', () => {
    const sql = migration('007_restore_and_checkpoint.sql')
    expect(sql).toMatch(/CREATE TABLE\s+IF\s+NOT\s+EXISTS\s+checkpoints/i)
    expect(sql).toMatch(/heads\s+jsonb/i)
    expect(sql).toMatch(/is_default\s+boolean/i)
    expect(sql).toMatch(/created_at\s+timestamptz/i)
  })

  it('enforces at most one default checkpoint', () => {
    const sql = migration('007_restore_and_checkpoint.sql')
    expect(sql).toMatch(/CREATE UNIQUE INDEX\s+IF\s+NOT\s+EXISTS\s+checkpoints_one_default/i)
    expect(sql).toMatch(/WHERE\s+is_default\s*=\s*true/i)
  })

  it("admits 'restore' as a change kind on revisions, ideas, costs and angles", () => {
    const sql = migration('007_restore_and_checkpoint.sql')
    for (const table of ['revisions', 'ideas', 'costs', 'angles']) {
      const idx = sql.indexOf(`ADD CONSTRAINT ${table}_change_kind_check`)
      expect(idx, `${table} change_kind check must be re-added`).toBeGreaterThan(-1)
      const block = sql.slice(idx, idx + 220)
      expect(block, `${table} must admit 'restore'`).toMatch(/'restore'/)
    }
  })

  it('never backfills the snapshot from the current live row', () => {
    const sql = migration('007_restore_and_checkpoint.sql')
    // The only assignment to snapshot must be NULL (the write path sets it);
    // no UPDATE ... SET snapshot = <live columns> statement is allowed.
    expect(sql).not.toMatch(/SET\s+snapshot\s*=\s*[a-z_]+\./i)
  })
})

describe('migration file ordering', () => {
  it('007 sorts after 006', () => {
    const files = readdirSync(MIGRATIONS)
      .filter(f => f.endsWith('.sql'))
      .sort()
    const idx006 = files.indexOf('006_revision_history.sql')
    const idx007 = files.indexOf('007_restore_and_checkpoint.sql')
    expect(idx006).toBeGreaterThan(-1)
    expect(idx007).toBeGreaterThan(-1)
    expect(idx007).toBeGreaterThan(idx006)
  })
})
