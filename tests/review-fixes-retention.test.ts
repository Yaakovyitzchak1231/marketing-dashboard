import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addTouch } from './helpers/lead-fixtures'
import { runOp } from '@/lib/ops/dispatch'
import { retentionPreview, retentionSweep, setRetentionPolicy } from '@/lib/retention/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Yaakov, Oct 11: the retention sweep asks the owner every time -- a confirm step listing
// what will go, and an opt-in (default off) to also delete old timeline history. Scores
// must keep working afterwards.
describe('review fix: retention sweep is reviewed and confirmed every run', () => {
  let db: TestDb
  let co: number
  const old = new Date(Date.now() - 400 * 86400_000).toISOString()
  const recent = new Date(Date.now() - 5 * 86400_000).toISOString()

  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Sweep Co' })
    await setRetentionPolicy(db, 'owner', { event_category: 'email_opened', keep_days: 90 })
    await addTouch(db, { companyId: co, event: 'email_opened', at: old })
    await addTouch(db, { companyId: co, event: 'email_opened', at: recent })
    for (const [at, key] of [[old, 'old-1'], [old, 'old-2'], [recent, 'new-1']] as const) {
      await db.query(`insert into lp.lead_events (occurred_at, type, company_id, source, dedupe_key) values ($1, 'email_opened', $2, 'manual', $3)`, [at, co, key])
    }
    const { rows: models } = await db.query<{ id: number }>(`select id from lp.score_models where entity = 'company' and kind = 'engagement' and campaign_id is null`)
    await runOp(db, 'owner', 'upsert_score_model', {
      id: models[0]?.id, name: 'Engagement', entity: 'company', kind: 'engagement',
      rules: [{ rule_key: 'opened', label: 'Opened', event_type: 'email_opened', points: 5 }],
    })
    await runOp(db, 'owner', 'recompute_scores', {})
  })
  afterAll(async () => { await db.close() })

  const score = async () => Number((await db.query<{ score: number }>(`select score from lp.scores where company_id = $1`, [co])).rows[0]?.score ?? -1)
  const count = async (sql: string) => Number((await db.query<{ n: number }>(sql, [co])).rows[0].n)

  it('previews what will be deleted, and deletes nothing without a confirmation', async () => {
    const p = await retentionPreview(db)
    const opened = p.categories.find((c) => c.event_category === 'email_opened')
    expect(opened).toMatchObject({ keep_days: 90, touches: 1, timeline_events: 2 })
    await expect(retentionSweep(db, 'owner')).rejects.toThrow(/Nothing was deleted/)
    expect(await count(`select count(*)::int n from lp.campaign_touches where company_id = $1`)).toBe(2)
  })

  it('a confirmed sweep keeps timeline history by default', async () => {
    const before = await score()
    const r = await retentionSweep(db, 'owner', { confirm: true })
    expect(r.total_deleted).toBe(1)
    expect(r.total_timeline_deleted).toBe(0)
    expect(await count(`select count(*)::int n from lp.lead_events where company_id = $1 and type = 'email_opened'`)).toBe(3)
    expect(await score()).toBe(before)
  })

  it('with the opt-in it also deletes old timeline history, and scores still work', async () => {
    const before = await score()
    expect(before).toBeGreaterThan(0)
    const r = await retentionSweep(db, 'owner', { confirm: true, include_timeline: true })
    expect(r.total_timeline_deleted).toBe(2)
    expect(await count(`select count(*)::int n from lp.lead_events where company_id = $1 and type = 'email_opened'`)).toBe(1)
    expect(await score()).toBe(before) // points already earned are kept
    await runOp(db, 'owner', 'recompute_scores', {}) // and a recompute still runs cleanly
    expect(await score()).toBeGreaterThanOrEqual(5)
  })
})
