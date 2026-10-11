import { describe, it, expect, vi, afterAll, beforeAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
vi.mock('server-only', () => ({}))
import { runOp } from '@/lib/ops/dispatch'

// Found in the Phase 2 end-to-end test (p2-e2e-report.md, S11): lib/fields and
// lib/segments both exported an op called `list_fields`; the later spread in
// lib/ops/dispatch.ts silently replaced the custom-fields one, so agents could
// not list custom field definitions. Guard: no two op modules share a name.
const root = join(__dirname, '..')

describe('ops API names', () => {
  it('no two op modules spread into the dispatcher define the same op name', async () => {
    const src = readFileSync(join(root, 'lib/ops/dispatch.ts'), 'utf8')
    const imports = new Map<string, string>()
    for (const m of src.matchAll(/import \{([^}]+)\} from '([^']+)'/g)) {
      for (const raw of m[1].split(',')) {
        const parts = raw.trim().split(/\s+as\s+/)
        const local = (parts[1] ?? parts[0]).trim()
        if (/_OPS$/.test(local)) imports.set(local, m[2])
      }
    }
    const spreads = [...src.matchAll(/^\s+\.\.\.([A-Z_]+_OPS),?$/gm)].map((m) => m[1])
    expect(spreads.length).toBeGreaterThan(10)
    const owner = new Map<string, string>()
    const clashes: string[] = []
    for (const name of spreads) {
      const spec = imports.get(name)
      expect(spec, name).toBeTruthy()
      const mod = (await import(join(root, 'lib/ops', spec!))) as Record<string, Record<string, unknown>>
      for (const op of Object.keys(mod[name] ?? {})) {
        if (owner.has(op)) clashes.push(`${op}: ${owner.get(op)} and ${name}`)
        else owner.set(op, name)
      }
    }
    expect(clashes).toEqual([])
  })
})

describe('list_fields is the custom-fields op again', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })
  it('lists defined custom fields; segment_fields lists the segment picker registry', async () => {
    await runOp(db, 'tab', 'define_field', { entity: 'contact', key: 'shoe_size', label: 'Shoe size', type: 'number' })
    const fields = (await runOp(db, 'tab', 'list_fields', {})) as { key: string; entity?: string }[]
    expect(fields.map((f) => f.key)).toContain('shoe_size')
    const registry = (await runOp(db, 'tab', 'segment_fields', {})) as { key: string }[]
    expect(registry.some((f) => f.key === 'company.state')).toBe(true)
  })
})
