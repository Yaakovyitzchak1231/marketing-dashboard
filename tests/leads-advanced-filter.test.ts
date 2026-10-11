import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { resolveAdvancedFilter } from '@/lib/leads/advanced'
import { runOp } from '@/lib/ops/dispatch'
import { listLeads } from '@/lib/leads/queries'
import { parseLeadQuery } from '@/lib/leads/filters'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('advanced filters narrow the Leads list (plan 2.5)', () => {
  let db: TestDb
  let ny: number
  let nj: number

  beforeAll(async () => {
    db = await createTestDb()
    ny = await addCompany(db, { name: 'NY Lead', state: 'NY' })
    nj = await addCompany(db, { name: 'NJ Lead', state: 'NJ' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('?seg=<id> restricts listLeads to exactly that segment\'s matches', async () => {
    const segment = (await runOp(db, 'tab', 'create_segment', {
      name: 'NY only', entity: 'company', definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] },
    })) as { id: number; name: string }

    const adv = await resolveAdvancedFilter(db, segment.id, null)
    expect(adv.source).toMatchObject({ kind: 'segment', id: segment.id, name: 'NY only' })
    expect(adv.companyIds).toEqual([ny])

    const q = parseLeadQuery({})
    const page = await listLeads(db, { ...q, filters: { ...q.filters, companyIds: adv.companyIds } })
    expect(page.rows.map((r) => r.id)).toEqual([ny])
    expect(page.total).toBe(1)
  })

  it('an ad-hoc ?f= definition narrows the same way, without being saved', async () => {
    const def = { entity: 'company' as const, include: [{ conditions: [{ kind: 'field' as const, field: 'company.state', op: 'is' as const, value: 'NJ' }] }], exclude: [] }
    const adv = await resolveAdvancedFilter(db, null, def)
    expect(adv.source).toEqual({ kind: 'ad_hoc' })
    expect(adv.companyIds).toEqual([nj])
  })

  it('a segment matching nothing yields zero rows, not "no restriction"', async () => {
    const segment = (await runOp(db, 'tab', 'create_segment', {
      name: 'Nobody', entity: 'company', definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'ZZ' }] }] },
    })) as { id: number }
    const adv = await resolveAdvancedFilter(db, segment.id, null)
    expect(adv.companyIds).toEqual([])
    const q = parseLeadQuery({})
    const page = await listLeads(db, { ...q, filters: { ...q.filters, companyIds: adv.companyIds } })
    expect(page.total).toBe(0)
  })

  it('no seg, no f: no restriction at all (old behaviour)', async () => {
    const adv = await resolveAdvancedFilter(db, null, null)
    expect(adv.companyIds).toBeNull()
    expect(adv.source).toBeNull()
  })

  it('a removed/unknown segment id shows zero rows, not everyone (companyIds: [], not null)', async () => {
    const adv = await resolveAdvancedFilter(db, 999999, null)
    expect(adv.companyIds).toEqual([])
    expect(adv.source).toBeNull()
  })
})
