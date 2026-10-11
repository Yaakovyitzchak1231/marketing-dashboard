import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { computeTraitValues, recomputeOneTrait, dirtyIds } from '@/lib/traits/compute'
import { defineTrait, getTrait } from '@/lib/traits/store'
import type { Trait } from '@/lib/traits/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function emitEvent(
  db: TestDb,
  opts: { type: string; companyId: number; occurredAt: string; props?: Record<string, unknown> },
) {
  await db.query(
    `insert into lp.lead_events (occurred_at, type, company_id, source, props) values ($1, $2, $3, 'test', $4)`,
    [opts.occurredAt, opts.type, opts.companyId, JSON.stringify(opts.props ?? {})],
  )
}

describe('trait aggregation (PGlite, real schema)', () => {
  let db: TestDb
  let coA: number // 3 replies, one 40 days ago (outside a 30d window)
  let coB: number // 0 replies, 2 meetings with minutes
  let coC: number // no events at all

  beforeAll(async () => {
    db = await createTestDb()
    coA = await addCompany(db, { name: 'Alpha' })
    coB = await addCompany(db, { name: 'Beta' })
    coC = await addCompany(db, { name: 'Gamma' })

    await emitEvent(db, { type: 'reply_received', companyId: coA, occurredAt: new Date(Date.now() - 5 * 86400000).toISOString() })
    await emitEvent(db, { type: 'reply_received', companyId: coA, occurredAt: new Date(Date.now() - 10 * 86400000).toISOString() })
    await emitEvent(db, { type: 'reply_received', companyId: coA, occurredAt: new Date(Date.now() - 40 * 86400000).toISOString() })

    await emitEvent(db, { type: 'meeting_booked', companyId: coB, occurredAt: new Date(Date.now() - 2 * 86400000).toISOString(), props: { minutes: 30 } })
    await emitEvent(db, { type: 'meeting_booked', companyId: coB, occurredAt: new Date(Date.now() - 1 * 86400000).toISOString(), props: { minutes: 45 } })
  })

  afterAll(async () => {
    await db.close()
  })

  it('count with a window excludes events outside it', async () => {
    const values = await computeTraitValues(
      db,
      { entity: 'company', definition: { event_types: ['reply_received'], aggregation: 'count', prop: null, window_days: 30, prop_filters: [] } },
      [coA, coB, coC],
    )
    const byId = new Map(values.map((v) => [v.entity_id, v.value]))
    expect(byId.get(coA)).toBe(2) // the 40-day-old reply is outside the window
    expect(byId.get(coB)).toBe(0)
    expect(byId.get(coC)).toBe(0)
  })

  it('count with no window counts everything', async () => {
    const values = await computeTraitValues(
      db,
      { entity: 'company', definition: { event_types: ['reply_received'], aggregation: 'count', prop: null, window_days: null, prop_filters: [] } },
      [coA],
    )
    expect(values[0].value).toBe(3)
  })

  it('sum aggregates a numeric prop', async () => {
    const values = await computeTraitValues(
      db,
      { entity: 'company', definition: { event_types: ['meeting_booked'], aggregation: 'sum', prop: 'minutes', window_days: null, prop_filters: [] } },
      [coB, coC],
    )
    const byId = new Map(values.map((v) => [v.entity_id, v.value]))
    expect(byId.get(coB)).toBe(75)
    expect(byId.get(coC)).toBeNull() // never happened -- not 0
  })

  it('min / max / last read the same prop differently', async () => {
    const min = await computeTraitValues(db, { entity: 'company', definition: { event_types: ['meeting_booked'], aggregation: 'min', prop: 'minutes', window_days: null, prop_filters: [] } }, [coB])
    const max = await computeTraitValues(db, { entity: 'company', definition: { event_types: ['meeting_booked'], aggregation: 'max', prop: 'minutes', window_days: null, prop_filters: [] } }, [coB])
    const last = await computeTraitValues(db, { entity: 'company', definition: { event_types: ['meeting_booked'], aggregation: 'last', prop: 'minutes', window_days: null, prop_filters: [] } }, [coB])
    expect(min[0].value).toBe(30)
    expect(max[0].value).toBe(45)
    expect(last[0].value).toBe(45) // the most recent meeting (1 day ago) had 45 minutes
  })

  it('days_since is null when the event never happened, a number otherwise', async () => {
    const values = await computeTraitValues(
      db,
      { entity: 'company', definition: { event_types: ['reply_received'], aggregation: 'days_since', prop: null, window_days: null, prop_filters: [] } },
      [coA, coC],
    )
    const byId = new Map(values.map((v) => [v.entity_id, v.value]))
    expect(byId.get(coA)).not.toBeNull()
    expect(byId.get(coA)!).toBeGreaterThan(4)
    expect(byId.get(coA)!).toBeLessThan(6)
    expect(byId.get(coC)).toBeNull()
  })

  it('a prop filter narrows which events count', async () => {
    await emitEvent(db, { type: 'email_link_clicked', companyId: coC, occurredAt: new Date().toISOString(), props: { url: '/pricing' } })
    await emitEvent(db, { type: 'email_link_clicked', companyId: coC, occurredAt: new Date().toISOString(), props: { url: '/about' } })
    const values = await computeTraitValues(
      db,
      {
        entity: 'company',
        definition: { event_types: ['email_link_clicked'], aggregation: 'count', prop: null, window_days: null, prop_filters: [{ path: 'url', op: 'contains', value: '/pricing' }] },
      },
      [coC],
    )
    expect(values[0].value).toBe(1)
  })

  it('incremental recompute only touches dirty entities, and matches what a full recompute produces for them', async () => {
    const trait = await defineTrait(db, 'tab', {
      key: 'test_replies',
      label: 'Test replies',
      entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'count', window_days: null },
    })

    // First run: last_computed_at is null -> "all dirty" -> a full recompute in practice.
    const first = await recomputeOneTrait(db, trait)
    expect(first.mode).toBe('incremental')
    expect(first.entities_touched).toBeGreaterThanOrEqual(3) // coA, coB, coC all exist

    const afterFirst = (await getTrait(db, 'test_replies')) as Trait
    expect(afterFirst.last_computed_at).not.toBeNull()

    const { rows: beforeRows } = await db.query<{ company_id: number; value: string }>(`select company_id, value from lp.trait_values where trait_key = 'test_replies'`)
    const beforeMap = new Map(beforeRows.map((r) => [Number(r.company_id), Number(r.value)]))
    expect(beforeMap.get(coA)).toBe(3)

    // A brand-new reply for coB only: coB is now dirty, coA/coC are not.
    await emitEvent(db, { type: 'reply_received', companyId: coB, occurredAt: new Date().toISOString() })
    const dirty = await dirtyIds(db, 'company', afterFirst.last_computed_at)
    expect(dirty).toEqual([coB])

    const second = await recomputeOneTrait(db, afterFirst)
    expect(second.mode).toBe('incremental')
    expect(second.entities_touched).toBe(1)

    const { rows: afterRows } = await db.query<{ company_id: number; value: string }>(`select company_id, value from lp.trait_values where trait_key = 'test_replies'`)
    const afterMap = new Map(afterRows.map((r) => [Number(r.company_id), Number(r.value)]))
    expect(afterMap.get(coA)).toBe(3) // untouched
    expect(afterMap.get(coB)).toBe(1) // recomputed: 1 reply now

    // A full recompute over everyone should agree with the incremental result for coB.
    const afterSecond = (await getTrait(db, 'test_replies')) as Trait
    const full = await recomputeOneTrait(db, afterSecond, { full: true })
    expect(full.mode).toBe('full')
    const { rows: fullRows } = await db.query<{ company_id: number; value: string }>(`select company_id, value from lp.trait_values where trait_key = 'test_replies'`)
    const fullMap = new Map(fullRows.map((r) => [Number(r.company_id), Number(r.value)]))
    expect(fullMap.get(coB)).toBe(afterMap.get(coB))
    expect(fullMap.get(coA)).toBe(afterMap.get(coA))
  })
})
