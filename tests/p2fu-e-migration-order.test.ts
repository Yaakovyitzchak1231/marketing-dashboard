import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { applyMigrations, migrationFiles } from '@/scripts/lib/migrate.mjs'

/**
 * Instinct #86 finding 9: db/migrations has duplicate numeric prefixes (two each of
 * 0016_ .. 0020_). That is only safe if the runner orders and tracks migrations by
 * the FULL filename, never by the numeric prefix. These tests pin that down.
 */
const REAL = join(__dirname, '..', 'db', 'migrations')

/** node-postgres-shaped client over PGlite (same shape as tests/db-migrate.test.ts). */
function client(pg: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params && params.length) return pg.query(text, params)
      const all = await pg.exec(text)
      return all[all.length - 1] ?? { rows: [] }
    },
  }
}

/** Plain code-unit comparison, written out so the test does not just re-run Array#sort(). */
function byFullName(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

describe('migration order (finding 9)', () => {
  it('lists the real migrations in lexicographic order of their FULL filenames', () => {
    const onDisk = readdirSync(REAL).filter((f) => f.endsWith('.sql'))
    const listed = migrationFiles(REAL)
    expect(listed).toEqual([...onDisk].sort(byFullName))
    // the duplicated prefixes sit next to each other, ordered by the rest of the name
    for (const n of ['0016', '0017', '0018', '0019', '0020']) {
      const same = listed.filter((f) => f.startsWith(`${n}_`))
      expect(same.length).toBeGreaterThanOrEqual(2)
      expect(same).toEqual([...same].sort(byFullName))
      const first = listed.indexOf(same[0])
      expect(listed.slice(first, first + same.length)).toEqual(same)
    }
  })

  it('applies and records two files that share a numeric prefix separately, in name order', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-dup-'))
    writeFileSync(join(dir, '0001_base.sql'), 'create table t (id int, src text);')
    // 0002_b depends on 0002_a having run first; both share prefix 0002
    writeFileSync(join(dir, '0002_a_first.sql'), "create table a (id int); insert into t values (1, '0002_a_first');")
    writeFileSync(join(dir, '0002_b_second.sql'), "insert into a values (1); insert into t values (2, '0002_b_second');")
    writeFileSync(join(dir, '0010_later.sql'), "insert into t values (3, '0010_later');")
    const pg = new PGlite()
    const r = await applyMigrations(client(pg), { dir })
    expect(r.failed).toBeNull()
    // '0010' sorts after '0002_*' as a string too, so numeric and lexicographic agree here
    expect(r.applied).toEqual(['0001_base.sql', '0002_a_first.sql', '0002_b_second.sql', '0010_later.sql'])
    const tracked = await pg.query<{ filename: string }>('select filename from lp_schema_migrations order by filename')
    expect(tracked.rows.map((x) => x.filename)).toEqual(['0001_base.sql', '0002_a_first.sql', '0002_b_second.sql', '0010_later.sql'])
    const ran = await pg.query<{ src: string }>('select src from t order by id')
    expect(ran.rows.map((x) => x.src)).toEqual(['0002_a_first', '0002_b_second', '0010_later'])

    // a new file with an already-used prefix is still picked up (tracking is by full name)
    writeFileSync(join(dir, '0002_c_added_later.sql'), "insert into t values (4, '0002_c_added_later');")
    const r2 = await applyMigrations(client(pg), { dir })
    expect(r2.failed).toBeNull()
    expect(r2.applied).toEqual(['0002_c_added_later.sql'])
    expect(r2.already).toEqual(['0001_base.sql', '0002_a_first.sql', '0002_b_second.sql', '0010_later.sql'])
    const r3 = await applyMigrations(client(pg), { dir })
    expect(r3.applied).toEqual([])
    await pg.close()
  })

  it('every real migration name is unique and matches NNNN_name.sql', () => {
    const names = readdirSync(REAL).filter((f) => f.endsWith('.sql'))
    expect(new Set(names).size).toBe(names.length)
    for (const f of names) expect(f).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/)
    // nothing that looks like a migration but would be skipped by the runner
    const strays = readdirSync(REAL).filter((f) => !f.endsWith('.sql') && /^\d{4}_/.test(f))
    expect(strays).toEqual([])
  })
})
