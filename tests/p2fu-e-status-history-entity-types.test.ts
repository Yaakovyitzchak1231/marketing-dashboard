import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { applyMigrations, migrationFiles } from '@/scripts/lib/migrate.mjs'

/**
 * Instinct #86 finding 8: several migrations drop and re-add
 * lp.status_history's status_history_entity_type_check. If a later one ever
 * re-declared a SHORTER list, or code started writing an entity_type the list
 * does not allow, the audit insert would fail at runtime and roll back the whole
 * action. Verified on main 5156b5d: 0025, 0030, 0031, 0033 and 0034 all declare the
 * same 24 values, every value the code writes is among them, so no migration was
 * needed. These tests keep it that way.
 */
const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'db', 'migrations')

function client(pg: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params && params.length) return pg.query(text, params)
      const all = await pg.exec(text)
      return all[all.length - 1] ?? { rows: [] }
    },
  }
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs|js)$/.test(name) && !/\.test\./.test(name)) out.push(p)
  }
  return out
}

/** entity_type literals the app writes straight into lp.status_history. */
function literalEntityTypesInCode(): Set<string> {
  const found = new Set<string>()
  const re = /insert into lp\.status_history\s*\(\s*entity_type[^)]*\)\s*values\s*\(\s*'([a-z_]+)'/gi
  for (const dir of ['lib', 'app', 'scripts']) {
    for (const f of walk(join(ROOT, dir))) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(re)) found.add(m[1])
    }
  }
  return found
}

/**
 * entity_type values written through a parameter ($1). Their TypeScript types
 * limit them to these: lib/edit/registry.ts EntityType, lib/fields/store.ts
 * ('company' | 'contact'), lib/leads/csv-import.ts and lib/leads/edit.ts
 * ('company' | 'contact'). 0001's status trigger writes company/contact too.
 */
const PARAM_ENTITY_TYPES = ['company', 'contact', 'campaign', 'campaign_lead', 'task']

/** Allowed lists in the order the migrations declare them. */
function declaredLists(): { file: string; values: string[] }[] {
  const out: { file: string; values: string[] }[] = []
  for (const f of migrationFiles(MIGRATIONS)) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    const re = /add constraint status_history_entity_type_check\s+check\s*\(\s*entity_type in \(([^)]*)\)\s*\)/gi
    for (const m of sql.matchAll(re)) out.push({ file: f, values: [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) })
  }
  return out
}

let pg: PGlite

beforeAll(async () => {
  pg = new PGlite()
  const r = await applyMigrations(client(pg), { dir: MIGRATIONS })
  expect(r.failed).toBeNull()
}, 120_000)

afterAll(async () => {
  await pg?.close()
})

async function effectiveList(): Promise<string[]> {
  const { rows } = await pg.query<{ def: string }>(
    `select pg_get_constraintdef(oid) as def from pg_constraint
      where conrelid = 'lp.status_history'::regclass and conname = 'status_history_entity_type_check'`,
  )
  expect(rows).toHaveLength(1)
  return [...rows[0].def.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

describe('status_history entity_type constraint (finding 8)', () => {
  it('no later migration re-declares a shorter list than an earlier one', () => {
    const lists = declaredLists()
    expect(lists.length).toBeGreaterThanOrEqual(6)
    for (let i = 1; i < lists.length; i++) {
      const missing = lists[i - 1].values.filter((v) => !lists[i].values.includes(v))
      expect({ file: lists[i].file, missing }).toEqual({ file: lists[i].file, missing: [] })
    }
  })

  it('the effective constraint after every migration is the last declared list', async () => {
    const lists = declaredLists()
    const last = lists[lists.length - 1].values
    expect([...(await effectiveList())].sort()).toEqual([...last].sort())
  })

  it('allows every entity_type the code writes, and still refuses an unknown one', async () => {
    const used = new Set([...literalEntityTypesInCode(), ...PARAM_ENTITY_TYPES])
    // sanity: the scan found the writers we know about
    for (const t of ['campaign_profile', 'field_def', 'file', 'score_model', 'tag', 'trait', 'suppression', 'actor', 'setting', 'job']) {
      expect(used.has(t)).toBe(true)
    }
    const allowed = await effectiveList()
    expect([...used].filter((t) => !allowed.includes(t))).toEqual([])

    await pg.exec('begin')
    try {
      for (const t of used) {
        await pg.query(
          `insert into lp.status_history (entity_type, entity_key, field, old_value, new_value, changed_by, via)
           values ($1, 'p2fu-e-probe', 'probe', null, 'x', 'test', 'ui')`,
          [t],
        )
      }
      const { rows } = await pg.query<{ n: number }>(`select count(*)::int as n from lp.status_history where entity_key = 'p2fu-e-probe'`)
      expect(rows[0].n).toBe(used.size)
    } finally {
      await pg.exec('rollback')
    }

    await expect(
      pg.query(`insert into lp.status_history (entity_type, entity_key, field, changed_by) values ('not_a_type', 'k', 'f', 'test')`),
    ).rejects.toThrow(/status_history_entity_type_check/)
  })

  it('records both files of each duplicated prefix (finding 9, on the real set)', async () => {
    const { rows } = await pg.query<{ filename: string }>('select filename from lp_schema_migrations')
    const tracked = new Set(rows.map((r) => r.filename))
    for (const f of migrationFiles(MIGRATIONS)) expect(tracked.has(f)).toBe(true)
    expect(tracked.size).toBe(migrationFiles(MIGRATIONS).length)
  })
})
