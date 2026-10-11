import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { recomputeOneTrait, isTimeRelative } from '@/lib/traits/compute'
import { defineTrait, getTrait } from '@/lib/traits/store'
import type { Trait } from '@/lib/traits/store'

// Review fix (#82, Viktor): 30-day and days-since traits never aged, because the
// hourly refresh only recomputed leads with a NEW event. Time alone must move them.
type TestDb = Awaited<ReturnType<typeof createTestDb>>
const ago = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

describe('time-relative traits age without new events (#82)', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Aging Co' })
    await db.query(
      `insert into lp.lead_events (occurred_at, type, company_id, source, props) values ($1, 'reply_received', $2, 'test', '{"amount":"demo"}')`,
      [ago(20), co],
    )
  })
  afterAll(async () => db?.close())

  it('replies_30d falls to 0 and days-since grows when the clock moves, with no new event', async () => {
    const win = await defineTrait(db, 'tab', {
      key: 'replies_30d_t', label: 'Replies 30d', entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'count', window_days: 30 },
    })
    const since = await defineTrait(db, 'tab', {
      key: 'days_since_reply_t', label: 'Days since reply', entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'days_since', window_days: null },
    })
    // A non-numeric prop value must not abort a sum trait.
    const sum = await defineTrait(db, 'tab', {
      key: 'amount_sum_t', label: 'Amount', entity: 'company',
      definition: { event_types: ['reply_received'], aggregation: 'sum', prop: 'amount', window_days: null },
    })
    expect(isTimeRelative(win.definition)).toBe(true)
    expect(isTimeRelative(since.definition)).toBe(true)
    expect(isTimeRelative(sum.definition)).toBe(false)

    await recomputeOneTrait(db, win)
    await recomputeOneTrait(db, since)
    await expect(recomputeOneTrait(db, sum)).resolves.toBeTruthy()
    const val = async (k: string) =>
      Number((await db.query<{ value: string }>(`select value from lp.trait_values where trait_key = $1 and company_id = $2`, [k, co])).rows[0].value)
    expect(await val('replies_30d_t')).toBe(1)
    const d1 = await val('days_since_reply_t')
    expect(d1).toBeGreaterThan(19.9)

    // Time passes: simulate it by moving the event 15 days further back (recorded_at
    // untouched, so the lead is NOT dirty for an incremental run).
    // (lead_events is append-only by trigger; the test lifts it just for this simulation.)
    await db.query(`set session_replication_role = replica`)
    await db.query(`update lp.lead_events set occurred_at = occurred_at - interval '15 days' where company_id = $1`, [co])
    await db.query(`set session_replication_role = origin`)
    const r1 = await recomputeOneTrait(db, (await getTrait(db, 'replies_30d_t')) as Trait)
    const r2 = await recomputeOneTrait(db, (await getTrait(db, 'days_since_reply_t')) as Trait)
    expect(r1.mode).toBe('full')
    expect(r2.mode).toBe('full')
    expect(await val('replies_30d_t')).toBe(0)
    expect(await val('days_since_reply_t')).toBeGreaterThan(d1 + 14)
  })
})
