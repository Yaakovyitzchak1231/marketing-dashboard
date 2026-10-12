import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import {
  createExperiment,
  getExperimentDetail,
  listExperiments,
  recordOutcome,
  updateExperiment,
  parseExperimentConfig,
  ExperimentsError,
} from '@/lib/experiments/store'
import { assignVariant, getAssignment, hashBucket, pickVariant, variantForBucket } from '@/lib/experiments/assign'
import { evaluateExperiment, selectVariantWinner } from '@/lib/experiments/winner'
import { nodeTypes, runJourneyNode } from '@/lib/journeys/nodes'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const ACTOR = 'owner'

async function makeCampaign(db: TestDb, name = 'Test campaign'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.campaigns (name, pool) values ($1, 'jeweler') returning id`,
    [name],
  )
  return rows[0].id
}

describe('parseExperimentConfig', () => {
  it('rejects fewer than 2 variants, dup keys, and bad weights', () => {
    expect(() => parseExperimentConfig({})).toThrow(ExperimentsError)
    expect(() => parseExperimentConfig({ variants: [{ key: 'A', weight: 100 }] })).toThrow(ExperimentsError)
    expect(() =>
      parseExperimentConfig({ variants: [{ key: 'A', weight: 50 }, { key: 'a', weight: 50 }] }),
    ).toThrow(/duplicate/i)
    expect(() =>
      parseExperimentConfig({ variants: [{ key: 'A', weight: 0 }, { key: 'B', weight: 50 }] }),
    ).toThrow(/weight/i)
  })
  it('normalizes defaults (auto_winner on, 100 min sends)', () => {
    const c = parseExperimentConfig({ variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 3 }] })
    expect(c).toMatchObject({ auto_winner: true, min_sends_per_variant: 100 })
  })
})

describe('selectVariantWinner (the insights z-test, reused)', () => {
  it('picks the winner when the gap is significant at 95%', () => {
    const pick = selectVariantWinner([
      { variant: 'A', sends: 1000, replies: 120 },
      { variant: 'B', sends: 1000, replies: 80 },
    ])
    expect(pick).not.toBeNull()
    expect(pick?.winner).toBe('A')
    expect(pick?.loser).toBe('B')
    expect(pick!.z).toBeGreaterThan(1.96)
  })
  it('returns null when the gap is noise', () => {
    expect(
      selectVariantWinner([
        { variant: 'A', sends: 1000, replies: 100 },
        { variant: 'B', sends: 1000, replies: 95 },
      ]),
    ).toBeNull()
  })
  it('returns null when a variant lacks the minimum sends', () => {
    expect(
      selectVariantWinner([
        { variant: 'A', sends: 99, replies: 50 },
        { variant: 'B', sends: 1000, replies: 80 },
      ]),
    ).toBeNull()
  })
  it('returns null with a single variant', () => {
    expect(selectVariantWinner([{ variant: 'A', sends: 500, replies: 50 }])).toBeNull()
  })
})

describe('assignment', () => {
  it('is deterministic: the same lead always lands in the same variant', () => {
    const cfg = [
      { key: 'A', weight: 50 },
      { key: 'B', weight: 50 },
    ]
    const b1 = hashBucket(7, 42, null)
    expect(hashBucket(7, 42, null)).toBe(b1)
    expect(variantForBucket(cfg, b1)).toBe(variantForBucket(cfg, b1))
  })
  it('splits traffic roughly by weight', () => {
    const cfg = [
      { key: 'A', weight: 1 },
      { key: 'B', weight: 3 },
    ]
    let a = 0
    for (let i = 1; i <= 2000; i++) {
      if (variantForBucket(cfg, hashBucket(9, i, null)) === 'A') a++
    }
    // 25% expected; allow generous bounds for a hash split
    expect(a).toBeGreaterThan(300)
    expect(a).toBeLessThan(700)
  })
})

describe('experiments store + node (db)', () => {
  let db: TestDb
  let campaignId: number
  let companyId: number
  let contactId: number

  beforeEach(async () => {
    db = await createTestDb()
    campaignId = await makeCampaign(db)
    companyId = await addCompany(db, { name: 'Acme Jewelers' })
    contactId = await addContact(db, companyId, 'a@acme.test')
  })
  afterEach(async () => {
    await db.close()
  })

  it('creates, lists, and fetches experiment detail', async () => {
    const exp = await createExperiment(db, ACTOR, {
      campaign_id: campaignId,
      step_number: 2,
      name: 'Subject test',
      config: { variants: [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }] },
    })
    expect(exp.status).toBe('draft')
    expect(exp.config.variants).toHaveLength(2)
    expect(await listExperiments(db, campaignId)).toHaveLength(1)
    const detail = await getExperimentDetail(db, exp.id)
    expect(detail?.assignments).toBe(0)
    expect(detail?.outcomes).toEqual([])
  })

  it('rejects a second experiment on the same step', async () => {
    await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'One' })
    await expect(
      createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Two' }),
    ).rejects.toThrow(/already has an experiment/)
  })

  it('moves draft -> running -> paused, and refuses hand-decided', async () => {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Flow' })
    expect((await updateExperiment(db, ACTOR, exp.id, { status: 'running' })).status).toBe('running')
    expect((await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })).status).toBe('paused')
    await expect(updateExperiment(db, ACTOR, exp.id, { status: 'decided' })).rejects.toThrow(/only by evaluation/)
  })

  it('assigns idempotently and routes to the winner once decided', async () => {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Assign' })
    await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
    const a1 = await assignVariant(db, exp.id, companyId, contactId)
    const a2 = await assignVariant(db, exp.id, companyId, contactId)
    expect(a1.variant).toBe(a2.variant)
    expect(a1.existing).toBe(false)
    expect(a2.existing).toBe(true)
    expect(await getAssignment(db, exp.id, companyId, contactId)).toMatchObject({ variant: a1.variant })

    // decided experiment: everyone goes to the winner
    await db.query(
      `update lp.experiments set status = 'decided', winner_variant = 'B', decided_at = now() where id = $1`,
      [exp.id],
    )
    const company2 = await addCompany(db, { name: 'Other Co' })
    const a3 = await assignVariant(db, exp.id, company2, null)
    expect(a3.variant).toBe('B')
  })

  it('refuses assignment while draft or paused', async () => {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Gated' })
    await expect(assignVariant(db, exp.id, companyId, null)).rejects.toThrow(/draft/)
    await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
    await expect(assignVariant(db, exp.id, companyId, null)).rejects.toThrow(/paused/)
  })

  it('accumulates outcomes with upserts', async () => {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Out' })
    await recordOutcome(db, exp.id, 'A', { sends: 100, replies: 10 })
    await recordOutcome(db, exp.id, 'A', { sends: 50, replies: 5 })
    const detail = await getExperimentDetail(db, exp.id)
    expect(detail?.outcomes).toMatchObject([{ variant: 'A', sends: 150, replies: 15 }])
    await expect(recordOutcome(db, exp.id, 'B', { sends: 10, replies: 11 })).rejects.toThrow(/sends >= replies/)
  })

  it('auto-decides a significant experiment and reports a close one as not ready', async () => {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Auto' })
    await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
    await recordOutcome(db, exp.id, 'A', { sends: 1000, replies: 120 })
    await recordOutcome(db, exp.id, 'B', { sends: 1000, replies: 80 })
    const ev = await evaluateExperiment(db, ACTOR, exp.id)
    expect(ev.decided).toBe(true)
    expect(ev.pick?.winner).toBe('A')
    const after = await getExperimentDetail(db, exp.id)
    expect(after?.status).toBe('decided')
    expect(after?.winner_variant).toBe('A')

    const exp2 = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 2, name: 'Close' })
    await updateExperiment(db, ACTOR, exp2.id, { status: 'running' })
    await recordOutcome(db, exp2.id, 'A', { sends: 1000, replies: 100 })
    await recordOutcome(db, exp2.id, 'B', { sends: 1000, replies: 95 })
    const ev2 = await evaluateExperiment(db, ACTOR, exp2.id)
    expect(ev2.decided).toBe(false)
    expect(ev2.eligible).toBe(false)
  })

  it('exposes ab_split through the journey node registry', async () => {
    expect(nodeTypes()).toContain('ab_split')
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Node' })
    await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
    const res = await runJourneyNode(
      db,
      ACTOR,
      { id: 'n1', type: 'ab_split', config: { experiment_id: exp.id } },
      { campaign_id: campaignId, company_id: companyId, contact_id: contactId },
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.data.variant).toBe(pickVariant({ ...exp, status: 'running' }, companyId, contactId))
      expect(res.data.experiment_id).toBe(exp.id)
    }
    const bad = await runJourneyNode(
      db,
      ACTOR,
      { id: 'n2', type: 'nope', config: {} },
      { campaign_id: campaignId, company_id: companyId, contact_id: null },
    )
    expect(bad).toMatchObject({ ok: false })
  })
})
