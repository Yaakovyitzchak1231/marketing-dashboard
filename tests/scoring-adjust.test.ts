/**
 * Sheet row 2.8 — the two missing pieces of lead scoring with point expiry:
 * (a) adjust_score: manual/programmatic score adjustment with an audit trail;
 * (b) leadScoreChips: the batch query behind the score chip in the leads table.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import {
  adjustScore,
  leadScoreChips,
  leadScores,
  recomputeScores,
  ScoringError,
  MANUAL_ADJUSTMENT_RULE_KEY,
} from '@/lib/scoring/engine'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function engagementModelId(db: TestDb): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`select id from lp.score_models where kind = 'engagement' and campaign_id is null`)
  return rows[0].id
}

describe('adjustScore', () => {
  let db: TestDb
  let companyId: number
  let modelId: number

  beforeAll(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Acme Co' })
    modelId = await engagementModelId(db)
    // Baseline: +10 reply, +2 opened = 12 on the default Engagement model.
    await db.tx(async (q) => {
      await emitLeadEvent(q, { type: 'reply_received', company_id: companyId, source: 'test' })
      await emitLeadEvent(q, { type: 'email_opened', company_id: companyId, source: 'test' })
    })
    await recomputeScores(db, 'owner', { company_id: companyId })
  })
  afterAll(async () => db.close())

  it('adds and subtracts points, and reports before/after', async () => {
    const up = await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 5, reason: 'Spoke at the trade show' })
    expect(up).toMatchObject({ model_id: modelId, company_id: companyId, previous_score: 12, score: 17 })
    expect(up.adjustment_id).toBeGreaterThan(0)
    const down = await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: -3, reason: 'Bounced a call' })
    expect(down).toMatchObject({ previous_score: 17, score: 14 })
  })

  it('writes a manual_adjustment point row with no source event and no expiry', async () => {
    const { rows } = await db.query<{ rule_key: string; points: number; source_event_id: number | null; expires_at: string | null }>(
      `select rule_key, points, source_event_id, expires_at from lp.score_points where model_id = $1 and company_id = $2 and rule_key = $3 order by id`,
      [modelId, companyId, MANUAL_ADJUSTMENT_RULE_KEY],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ rule_key: 'manual_adjustment', points: 5, source_event_id: null, expires_at: null })
    expect(rows[1]).toMatchObject({ points: -3, source_event_id: null, expires_at: null })
  })

  it('leaves a score_adjusted audit event with who/when/how much/why', async () => {
    const { rows } = await db.query<{ source: string; actor: string; props: Record<string, unknown> }>(
      `select source, actor, props from lp.lead_events where type = 'score_adjusted' and company_id = $1 order by id`,
      [companyId],
    )
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ source: 'dashboard', actor: 'owner' })
    expect(rows[0].props).toMatchObject({
      model_id: modelId,
      points: 5,
      reason: 'Spoke at the trade show',
      previous_score: 12,
      new_score: 17,
    })
    expect(rows[0].props.adjustment_id).toBeGreaterThan(0)
  })

  it('manual adjustments survive a recompute (only event-sourced points are rebuilt)', async () => {
    await recomputeScores(db, 'owner', { company_id: companyId })
    const scores = await leadScores(db, companyId)
    expect(scores.find((s) => s.model.kind === 'engagement')?.score).toBe(14)
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from lp.score_points where model_id = $1 and company_id = $2 and rule_key = $3`,
      [modelId, companyId, MANUAL_ADJUSTMENT_RULE_KEY],
    )
    expect(rows[0].n).toBe(2)
  })

  it('a large adjustment can cross a threshold, emitting score_threshold_crossed once', async () => {
    const hot = await addCompany(db, { name: 'Hot Co' })
    await adjustScore(db, 'owner', { model_id: modelId, company_id: hot, points: 30, reason: 'VIP referral' })
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from lp.lead_events where type = 'score_threshold_crossed' and company_id = $1`,
      [hot],
    )
    expect(rows[0].n).toBe(1)
    const scores = await leadScores(db, hot)
    expect(scores.find((s) => s.model.kind === 'engagement')?.threshold).toBe('hot')
  })

  it('validates its inputs', async () => {
    await expect(adjustScore(db, 'owner', { model_id: 999999, company_id: companyId, points: 5, reason: 'x' })).rejects.toThrow(ScoringError)
    await expect(adjustScore(db, 'owner', { model_id: modelId, contact_id: companyId, points: 5, reason: 'x' })).rejects.toThrow(/give company_id/)
    await expect(adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 0, reason: 'x' })).rejects.toThrow(/nonzero/)
    await expect(adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 1.5, reason: 'x' })).rejects.toThrow(/nonzero/)
    await expect(adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 1001, reason: 'x' })).rejects.toThrow(/between/)
    await expect(adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 5, reason: '  ' })).rejects.toThrow(/reason is required/)
  })
})

describe('adjustScore idempotency', () => {
  let db: TestDb
  let companyId: number
  let modelId: number
  beforeAll(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Idem Co' })
    modelId = await engagementModelId(db)
  })
  afterAll(async () => db.close())

  async function manualPointsRows(co: number): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from lp.score_points where model_id = $1 and company_id = $2 and rule_key = $3`,
      [modelId, co, MANUAL_ADJUSTMENT_RULE_KEY],
    )
    return rows[0].n
  }

  it('the same idempotency key twice inserts one points row and returns the original adjustment_id', async () => {
    const first = await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 5, reason: 'Manual bump', idempotency_key: 'req-1' })
    const second = await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 5, reason: 'Manual bump', idempotency_key: 'req-1' })
    expect(second.adjustment_id).toBe(first.adjustment_id)
    expect(second.score).toBe(first.score)
    expect(second.previous_score).toBe(first.score) // replay: nothing new applied
    expect(await manualPointsRows(companyId)).toBe(1)
  })

  it('the key is stored in the score_adjusted event props', async () => {
    const { rows } = await db.query<{ props: Record<string, unknown> }>(
      `select props from lp.lead_events where type = 'score_adjusted' and company_id = $1 order by id desc limit 1`,
      [companyId],
    )
    expect(rows[0].props).toMatchObject({ idempotency_key: 'req-1' })
  })

  it('a replay with different points still returns the original (first write wins)', async () => {
    const before = (await leadScores(db, companyId)).find((s) => s.model.id === modelId)?.score
    const again = await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 999, reason: 'Different', idempotency_key: 'req-1' })
    expect(again.score).toBe(before)
    expect(await manualPointsRows(companyId)).toBe(1)
  })

  it('different keys insert two rows', async () => {
    await adjustScore(db, 'owner', { model_id: modelId, company_id: companyId, points: 5, reason: 'Second key', idempotency_key: 'req-2' })
    expect(await manualPointsRows(companyId)).toBe(2)
  })

  it('the same key on a different lead is a new adjustment', async () => {
    const other = await addCompany(db, { name: 'Idem Other' })
    const r = await adjustScore(db, 'owner', { model_id: modelId, company_id: other, points: 5, reason: 'Same key, other lead', idempotency_key: 'req-1' })
    expect(r.adjustment_id).toBeGreaterThan(0)
    expect(await manualPointsRows(companyId)).toBe(2)
    expect(await manualPointsRows(other)).toBe(1)
  })

  it('the adjust_score op accepts and replays an idempotency key', async () => {
    const a = (await runOp(db, 'owner', 'adjust_score', { model_id: modelId, company_id: companyId, points: 4, reason: 'op key', idempotency_key: 'op-1' })) as { adjustment_id: number; score: number }
    const b = (await runOp(db, 'owner', 'adjust_score', { model_id: modelId, company_id: companyId, points: 4, reason: 'op key', idempotency_key: 'op-1' })) as { adjustment_id: number; score: number }
    expect(b.adjustment_id).toBe(a.adjustment_id)
    expect(b.score).toBe(a.score)
  })
})

describe('adjust_score op', () => {
  let db: TestDb
  let companyId: number
  let modelId: number
  beforeAll(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Op Co' })
    modelId = await engagementModelId(db)
  })
  afterAll(async () => db.close())

  it('is owner-or-system only', async () => {
    // 'tab' is an agent, not owner/system: the op refuses before touching anything.
    await expect(runOp(db, 'tab', 'adjust_score', { model_id: modelId, company_id: companyId, points: 5, reason: 'x' })).rejects.toBeInstanceOf(OpsError)
  })

  it('adjusts through the ops API as the owner', async () => {
    const r = (await runOp(db, 'owner', 'adjust_score', { model_id: modelId, company_id: companyId, points: 7, reason: 'Met at conference' })) as { score: number }
    expect(r.score).toBe(7)
    const { rows } = await db.query<{ type: string; source: string }>(
      `select type, source from lp.lead_events where type = 'score_adjusted' and company_id = $1`,
      [companyId],
    )
    expect(rows[0].source).toBe('ops_api')
  })
})

describe('leadScoreChips', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('returns the highest score per company with model name and threshold label', async () => {
    const co1 = await addCompany(db, { name: 'Chip One' })
    const co2 = await addCompany(db, { name: 'Chip Two' })
    const modelId = await engagementModelId(db)
    await db.tx(async (q) => {
      await emitLeadEvent(q, { type: 'reply_received', company_id: co1, source: 'test' })
      await emitLeadEvent(q, { type: 'meeting_booked', company_id: co1, source: 'test' }) // 10 + 15 = 25 -> hot
    })
    await recomputeScores(db, 'owner', { company_id: co1 })
    const chips = await leadScoreChips(db, [co1, co2, 999999])
    expect(chips.get(co1)).toMatchObject({ score: 25, threshold_label: 'Hot' })
    expect(chips.get(co1)?.model_name).toContain('Engagement')
    expect(chips.has(co2)).toBe(false) // never scored: no chip, not a made-up 0
    expect(chips.has(999999)).toBe(false)
  })

  it('returns an empty map for no ids', async () => {
    expect((await leadScoreChips(db, [])).size).toBe(0)
  })
})
