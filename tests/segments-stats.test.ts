import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('segment stats + alerts (2.12)', () => {
  let db: TestDb
  let segId: number

  beforeAll(async () => {
    db = await createTestDb()
    await addCompany(db, { name: 'Co 1', state: 'NY' })
    await addCompany(db, { name: 'Co 2', state: 'NY' })
    const seg = (await runOp(db, 'tab', 'create_segment', {
      name: 'NY leads',
      entity: 'company',
      definition: { entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }] },
    })) as { id: number }
    segId = seg.id
  })

  afterAll(async () => {
    await db.close()
  })

  it('segment_stats returns an empty-but-honest history before any snapshot has run', async () => {
    const stats = (await runOp(db, 'tab', 'segment_stats', { id: segId })) as { history: unknown[]; metrics: { sample_size: number } }
    expect(stats.history).toEqual([])
    expect(stats.metrics.sample_size).toBe(2)
  })

  it('segment_snapshot writes history segment_stats then reads back', async () => {
    await runOp(db, 'tab', 'segment_snapshot', {})
    const stats = (await runOp(db, 'tab', 'segment_stats', { id: segId })) as { history: { companies: number }[] }
    expect(stats.history.length).toBe(1)
    expect(stats.history[0].companies).toBe(2)
  })

  it('avg_score is omitted (null) when no score field is registered, never a fake number', async () => {
    const stats = (await runOp(db, 'tab', 'segment_stats', { id: segId })) as { metrics: { avg_score: number | null; avg_score_field: string | null } }
    expect(stats.metrics.avg_score).toBeNull()
    expect(stats.metrics.avg_score_field).toBeNull()
  })

  it('a growth/shrink threshold fires exactly once per crossing', async () => {
    await db.query(`update lp.segments set alert_rule = $1 where id = $2`, [JSON.stringify({ enabled: true, shrink_pct: 10 }), segId])
    // Force a second, smaller snapshot "yesterday" and today's real one shrinks the segment.
    await db.query(`insert into lp.segment_snapshots (segment_id, taken_at, taken_on, companies, contacts, sendable) values ($1, now() - interval '1 day', current_date - 1, 10, 10, 0)`, [segId])
    const before = (await db.query(`select count(*)::int as n from lp.notifications where kind = 'segment_alert'`)).rows[0] as { n: number }
    await runOp(db, 'tab', 'segment_snapshot', {}) // today's real snapshot: 2 companies, down from 10 -> an 80% shrink
    const afterFirst = (await db.query(`select count(*)::int as n from lp.notifications where kind = 'segment_alert'`)).rows[0] as { n: number }
    expect(afterFirst.n).toBe(before.n + 1)
    // Running it again the same day (segment_snapshot is safe to re-run) must not alert twice.
    await runOp(db, 'tab', 'segment_snapshot', {})
    const afterSecond = (await db.query(`select count(*)::int as n from lp.notifications where kind = 'segment_alert'`)).rows[0] as { n: number }
    expect(afterSecond.n).toBe(afterFirst.n)
  })
})
