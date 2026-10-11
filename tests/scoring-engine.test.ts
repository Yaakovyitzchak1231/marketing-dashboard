import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany } from './helpers/lead-fixtures'
import { emitLeadEvent } from '@/lib/events/emit'
import { recomputeScores, upsertScoreModel, leadScores, fitModelForCampaign } from '@/lib/scoring/engine'
import { createCampaign } from '@/lib/campaigns/store'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('scoring engine (point awards, expiry, recompute, threshold events)', () => {
  let db: TestDb
  let companyId: number

  beforeAll(async () => {
    db = await createTestDb()
    companyId = await addCompany(db, { name: 'Acme Co' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('the default Engagement model was seeded by the migration', async () => {
    const { rows } = await db.query<{ id: number; kind: string }>(`select id, kind from lp.score_models where kind = 'engagement' and campaign_id is null`)
    expect(rows).toHaveLength(1)
  })

  it('awards points from matching events and sums them into lp.scores', async () => {
    await db.tx(async (q) => {
      await emitLeadEvent(q, { type: 'reply_received', company_id: companyId, source: 'test' })
      await emitLeadEvent(q, { type: 'email_opened', company_id: companyId, source: 'test' })
    })
    const results = await recomputeScores(db, 'claude', { company_id: companyId })
    const engagement = results.find((r) => r.score >= 0)
    expect(engagement).toBeTruthy()
    const scores = await leadScores(db, companyId)
    const eng = scores.find((s) => s.model.kind === 'engagement')
    expect(eng?.score).toBe(12) // +10 replied, +2 opened
  })

  it('recompute is idempotent: re-running does not double-award the same events', async () => {
    await recomputeScores(db, 'claude', { company_id: companyId })
    const scores = await leadScores(db, companyId)
    const eng = scores.find((s) => s.model.kind === 'engagement')
    expect(eng?.score).toBe(12)
  })

  it('expired points drop the score on the next recompute', async () => {
    const opened = await db.tx((q) => emitLeadEvent(q, { type: 'email_opened', company_id: companyId, source: 'test', occurred_at: '2020-01-01T00:00:00Z' }))
    expect(opened.inserted).toBe(true)
    // "now" far enough past both opens' 30-day expiry (one dated 2020-01-01, one awarded "now" in the earlier test) that neither opened-event point is still live.
    await recomputeScores(db, 'claude', { company_id: companyId, now: new Date(Date.now() + 40 * 86400000) } as never)
    const scores = await leadScores(db, companyId)
    const eng = scores.find((s) => s.model.kind === 'engagement')
    // Both opens (the fresh one from the first test + this old one) are now past their 30-day expiry
    // relative to 2026-06-01, so only the +10 reply survives.
    expect(eng?.score).toBe(10)
  })

  it('a bounce can take the score negative, uncapped unless max_points is set', async () => {
    const companyId2 = await addCompany(db, { name: 'Bounced Co' })
    await db.tx((q) => emitLeadEvent(q, { type: 'email_bounced', company_id: companyId2, source: 'test' }))
    await recomputeScores(db, 'claude', { company_id: companyId2 })
    const scores = await leadScores(db, companyId2)
    expect(scores.find((s) => s.model.kind === 'engagement')?.score).toBe(-20)
  })

  it('threshold crossing emits exactly one score_threshold_crossed event, even across repeated recomputes', async () => {
    const companyId3 = await addCompany(db, { name: 'Hot Co' })
    await db.tx((q) => emitLeadEvent(q, { type: 'reply_received', company_id: companyId3, source: 'test' }))
    await db.tx((q) => emitLeadEvent(q, { type: 'meeting_booked', company_id: companyId3, source: 'test' })) // 10 + 15 = 25 >= hot(25)
    await recomputeScores(db, 'claude', { company_id: companyId3 })
    await recomputeScores(db, 'claude', { company_id: companyId3 })
    await recomputeScores(db, 'claude', { company_id: companyId3 })
    const { rows } = await db.query<{ n: number }>(`select count(*)::int as n from lp.lead_events where type = 'score_threshold_crossed' and company_id = $1`, [companyId3])
    expect(rows[0].n).toBe(1)
    const scores = await leadScores(db, companyId3)
    expect(scores.find((s) => s.model.kind === 'engagement')?.threshold).toBe('hot')
  })

  it('per-campaign fit model reads rules from the campaign profile (campaign-agnostic)', async () => {
    const campaign = await createCampaign(db, 'owner', { name: 'Test Campaign' } as never)
    await db.query(
      `insert into lp.campaign_profile_items (campaign_id, kind, name, config, status) values ($1, 'signal_rule', 'Hiring a seller', $2::jsonb, 'approved')`,
      [campaign.id, JSON.stringify({ event_type: 'custom', signal_type: 'hiring', points: 12 })],
    )
    const model = await fitModelForCampaign(db, 'claude', campaign.id)
    expect(model.campaign_id).toBe(campaign.id)
    expect(model.rules).toHaveLength(1)
    expect(model.rules[0]).toMatchObject({ points: 12, event_type: 'custom' })

    const leadCo = await addCompany(db, { name: 'Fit Lead Co' })
    await db.tx((q) => emitLeadEvent(q, { type: 'custom', company_id: leadCo, campaign_id: campaign.id, source: 'test', props: { signal_type: 'hiring' } }))
    await recomputeScores(db, 'claude', { model_id: model.id, company_id: leadCo })
    const { rows } = await db.query<{ score: number }>(`select score from lp.scores where model_id = $1 and company_id = $2`, [model.id, leadCo])
    expect(rows[0].score).toBe(12)
  })

  it('upsert_score_model validates rules, and refuses a second default model for the same entity+kind', async () => {
    const created = await upsertScoreModel(db, 'owner', {
      name: 'Custom Contact Engagement',
      entity: 'contact',
      kind: 'engagement',
      campaign_id: null,
      rules: [{ rule_key: 'x', label: 'X', event_type: 'reply_received', points: 1 }],
    })
    expect(created.id).toBeGreaterThan(0)
    await expect(
      upsertScoreModel(db, 'owner', { name: 'Bad', entity: 'contact', kind: 'engagement', campaign_id: null, rules: [{ rule_key: 'x' }] }),
    ).rejects.toThrow() // a second default (contact, engagement) model
    await expect(
      upsertScoreModel(db, 'owner', { name: 'Bad rules', entity: 'company', kind: 'fit', campaign_id: 999999, rules: [{ rule_key: 'x' }] }),
    ).rejects.toThrow() // malformed rule (missing event_type/points)
  })

  it('ops door: list_score_models / recompute_scores / lead_scores are wired', async () => {
    const models = await runOp(db, 'claude', 'list_score_models', {})
    expect(Array.isArray(models)).toBe(true)
    const result = await runOp(db, 'claude', 'lead_scores', { company_id: companyId })
    expect(Array.isArray(result)).toBe(true)
    await expect(runOp(db, 'claude', 'lead_scores', { company_id: 'nope' })).rejects.toBeInstanceOf(OpsError)
  })
})
