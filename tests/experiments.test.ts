import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import type { Db } from '@/lib/db/types'
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
import { criticalZ, evaluateExperiment, lookLevel, MAX_LOOKS, selectVariantWinner, testAlpha } from '@/lib/experiments/winner'
import { getNodeHandler, nodeKinds, type NodeContext } from '@/lib/journeys/nodes'
import { AB_WAIT_MINUTES } from '@/lib/journeys/ab-split'
import { GraphError, validateGraph } from '@/lib/journeys/graph'
import { advanceRun } from '@/lib/journeys/runner'
import { runOp } from '@/lib/ops/dispatch'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const ACTOR = 'owner'
const AB = [{ key: 'A', weight: 50 }, { key: 'B', weight: 50 }]

async function makeCampaign(db: TestDb, name = 'Test campaign'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.campaigns (name, pool) values ($1, 'jeweler') returning id`,
    [name],
  )
  return rows[0].id
}

async function failure(p: Promise<unknown>): Promise<ExperimentsError> {
  try {
    await p
  } catch (e) {
    expect(e).toBeInstanceOf(ExperimentsError)
    return e as ExperimentsError
  }
  throw new Error('expected the call to be rejected')
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
  it('accepts only variant keys matching ^[A-Za-z0-9_-]{1,32}$ (no colon, no space)', () => {
    const cfg = (key: string) => parseExperimentConfig({ variants: [{ key, weight: 1 }, { key: 'Z', weight: 1 }] })
    expect(cfg('A').variants[0].key).toBe('A')
    expect(cfg('subject_v-2').variants[0].key).toBe('subject_v-2')
    expect(cfg('x'.repeat(32)).variants[0].key).toHaveLength(32)
    for (const bad of ['A:B', 'has space', 'x'.repeat(33), 'é', 'a/b']) {
      expect(() => cfg(bad), bad).toThrow(/key must be 1-32/)
    }
  })
})

describe('selectVariantWinner (the insights z-test, extended)', () => {
  const s = (variant: string, sends: number, positive_replies: number) => ({ variant, sends, positive_replies })

  it('picks the winner when the gap is significant at 95%', () => {
    const pick = selectVariantWinner([s('A', 1000, 120), s('B', 1000, 80)])
    expect(pick?.winner).toBe('A')
    expect(pick?.loser).toBe('B')
    expect(pick!.z).toBeGreaterThan(1.96)
    expect(pick!.z_critical).toBe(1.96)
    expect(pick!.winner_rate).toBeCloseTo(0.12, 10)
    expect(pick!.loser_rate).toBeCloseTo(0.08, 10)
  })
  it('returns null when the gap is noise', () => {
    expect(selectVariantWinner([s('A', 1000, 100), s('B', 1000, 95)])).toBeNull()
  })
  it('returns null when a variant lacks the minimum sends', () => {
    expect(selectVariantWinner([s('A', 99, 50), s('B', 1000, 80)])).toBeNull()
  })
  it('returns null with a single variant', () => {
    expect(selectVariantWinner([s('A', 500, 50)])).toBeNull()
  })

  describe('three variants', () => {
    it('compares the best against EVERY other variant: a middle variant that ties the best blocks the win', () => {
      // A 12% vs C 6% is hugely significant (best vs worst would crown A), but B at 11.5% is indistinguishable from A.
      const stats = [s('A', 1000, 120), s('B', 1000, 115), s('C', 1000, 60)]
      expect(selectVariantWinner(stats)).toBeNull()
      // Remove the tie and A wins against both.
      const pick = selectVariantWinner([s('A', 1000, 160), s('B', 1000, 90), s('C', 1000, 60)])
      expect(pick?.winner).toBe('A')
      expect(pick?.comparisons.map((c) => c.variant).sort()).toEqual(['B', 'C'])
      // the reported rival is the strongest one (B), and z is the smallest comparison z
      expect(pick?.loser).toBe('B')
      expect(pick?.z).toBe(Math.min(...pick!.comparisons.map((c) => c.z)))
    })
    it('applies a Bonferroni-corrected alpha: a gap that clears 1.96 for two variants can fail for three', () => {
      // z of A (10.5%) vs B (7.8%) at n=1000 is about 2.09: a winner with two variants.
      expect(selectVariantWinner([s('A', 1000, 105), s('B', 1000, 78)])?.winner).toBe('A')
      // With a third variant the per-test alpha is 0.025 (z_critical about 2.24). Pick a gap to B whose z
      // falls between 1.96 and 2.24: significant on its own, not a winner once corrected.
      const z = (k1: number, k2: number) => (k1 - k2) / 1000 / Math.sqrt(((k1 + k2) / 2000) * (1 - (k1 + k2) / 2000) * (2 / 1000))
      expect(z(105, 78)).toBeGreaterThan(1.96)
      expect(z(105, 78)).toBeLessThan(criticalZ(testAlpha(3)))
      expect(selectVariantWinner([s('A', 1000, 105), s('B', 1000, 78), s('C', 1000, 40)])).toBeNull()
    })
    it('needs the minimum sample on EVERY variant, not just two of them', () => {
      expect(selectVariantWinner([s('A', 1000, 160), s('B', 1000, 60), s('C', 40, 0)])).toBeNull()
    })
    it('computes rates from raw counts, never an average of rates', () => {
      const pick = selectVariantWinner([s('A', 2000, 240), s('B', 100, 5)])
      // 240/2000 = 12%, 5/100 = 5%: not (12 + 5) / 2 anywhere
      expect(pick?.winner_rate).toBeCloseTo(0.12, 10)
      expect(pick?.loser_rate).toBeCloseTo(0.05, 10)
    })
  })

  it('criticalZ: alpha 0.05 is exactly 1.96 and smaller alphas are stricter', () => {
    expect(criticalZ(0.05)).toBe(1.96)
    expect(criticalZ(0.025)).toBeCloseTo(2.2414, 3)
    expect(criticalZ(0.01)).toBeCloseTo(2.5758, 3)
    expect(testAlpha(3, MAX_LOOKS)).toBeCloseTo(0.05 / (2 * MAX_LOOKS), 12)
  })
  it('lookLevel doubles with the smallest sample', () => {
    expect([0, 99, 100, 199, 200, 399, 400, 800, 1600].map((n) => lookLevel(n, 100))).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 5])
  })
})

describe('assignment (pure)', () => {
  it('is deterministic: the same lead always lands in the same variant', () => {
    const b1 = hashBucket(7, 42)
    expect(hashBucket(7, 42)).toBe(b1)
    expect(variantForBucket(AB, b1)).toBe(variantForBucket(AB, b1))
  })
  it('splits traffic roughly by weight', () => {
    const cfg = [{ key: 'A', weight: 1 }, { key: 'B', weight: 3 }]
    let a = 0
    for (let i = 1; i <= 2000; i++) if (variantForBucket(cfg, hashBucket(9, i)) === 'A') a++
    expect(a).toBeGreaterThan(300)
    expect(a).toBeLessThan(700)
  })
})

describe('experiments store, assignment, outcomes and the node (db)', () => {
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

  async function running(step = 1, config?: unknown) {
    const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: step, name: `Exp ${step}`, config })
    await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
    return exp
  }

  it('creates, lists, and fetches experiment detail', async () => {
    const exp = await createExperiment(db, ACTOR, {
      campaign_id: campaignId, step_number: 2, name: 'Subject test', config: { variants: AB },
    })
    expect(exp.status).toBe('draft')
    expect(exp.config.variants).toHaveLength(2)
    expect(await listExperiments(db, campaignId)).toHaveLength(1)
    const detail = await getExperimentDetail(db, exp.id)
    expect(detail?.assignments).toBe(0)
    expect(detail?.outcomes).toEqual([])
  })

  it('allows one experiment per step (unique (campaign_id, step_number), intended)', async () => {
    await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'One' })
    await expect(
      createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Two' }),
    ).rejects.toThrow(/already has an experiment/)
    // another step, or the same step on another campaign, is fine
    await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 2, name: 'Two' })
    const other = await makeCampaign(db, 'Other')
    await createExperiment(db, ACTOR, { campaign_id: other, step_number: 1, name: 'Other one' })
  })

  describe('status transitions and config freezing', () => {
    it('allows draft->running, running<->paused, running|paused->decided, and nothing else', async () => {
      const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Flow' })
      // draft cannot pause, decide, or stay draft
      for (const bad of ['paused', 'decided', 'draft'] as const) {
        expect((await failure(updateExperiment(db, ACTOR, exp.id, { status: bad, winner_variant: 'A' }))).status, bad).toBeGreaterThanOrEqual(400)
      }
      expect((await updateExperiment(db, ACTOR, exp.id, { status: 'running' })).status).toBe('running')
      // running -> draft is not allowed
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: 'draft' }))).toMatchObject({ status: 409 })
      expect((await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })).status).toBe('paused')
      // paused -> draft is not allowed either
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: 'draft' }))).toMatchObject({ status: 409 })
      expect((await updateExperiment(db, ACTOR, exp.id, { status: 'running' })).status).toBe('running')
      const decided = await updateExperiment(db, ACTOR, exp.id, { status: 'decided', winner_variant: 'B' })
      expect(decided).toMatchObject({ status: 'decided', winner_variant: 'B', decided_by: ACTOR })
      expect(decided.decided_at).toBeInstanceOf(Date)
      // decided is final
      for (const next of ['running', 'paused', 'draft'] as const) {
        expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: next })), next).toMatchObject({ status: 409 })
      }
    })

    it('a paused experiment can be decided by hand, but only with a configured winner', async () => {
      const exp = await running()
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: 'decided' }))).toMatchObject({ status: 400 })
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: 'decided', winner_variant: 'Z' }))).toMatchObject({ status: 400 })
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { status: 'running', winner_variant: 'A' }))).toMatchObject({ status: 400 })
      expect((await updateExperiment(db, ACTOR, exp.id, { status: 'decided', winner_variant: 'A' })).winner_variant).toBe('A')
    })

    it('edits config only while the experiment is a draft', async () => {
      const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Cfg' })
      const edited = await updateExperiment(db, ACTOR, exp.id, {
        config: { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }] },
      })
      expect(edited.config.variants).toHaveLength(3)
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { config: { variants: AB } }))).toMatchObject({ status: 409 })
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      expect(await failure(updateExperiment(db, ACTOR, exp.id, { config: { variants: AB } }))).toMatchObject({ status: 409 })
      // the stored config did not change
      expect((await getExperimentDetail(db, exp.id))?.config.variants).toHaveLength(3)
      // a rename is still fine
      expect((await updateExperiment(db, ACTOR, exp.id, { name: 'Renamed' })).name).toBe('Renamed')
    })
  })

  describe('assignVariant', () => {
    it('assigns idempotently and routes new leads to the winner once decided', async () => {
      const exp = await running()
      const a1 = await assignVariant(db, exp.id, companyId, contactId)
      const a2 = await assignVariant(db, exp.id, companyId, contactId)
      expect(a1.assigned && a2.assigned).toBe(true)
      if (!a1.assigned || !a2.assigned) return
      expect(a1.variant).toBe(a2.variant)
      expect(a1.existing).toBe(false)
      expect(a2.existing).toBe(true)
      expect(await getAssignment(db, exp.id, companyId)).toMatchObject({ variant: a1.variant })

      await db.query(`update lp.experiments set status = 'decided', winner_variant = 'B', decided_at = now() where id = $1`, [exp.id])
      const company2 = await addCompany(db, { name: 'Other Co' })
      const a3 = await assignVariant(db, exp.id, company2, null)
      expect(a3).toMatchObject({ assigned: true, variant: 'B' })
    })

    it('refuses assignment while draft or paused', async () => {
      const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Gated' })
      await expect(assignVariant(db, exp.id, companyId, null)).rejects.toThrow(/draft/)
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      await expect(assignVariant(db, exp.id, companyId, null)).rejects.toThrow(/paused/)
    })

    it('gives one person exactly one assignment however they are addressed (company only, or any of their contacts)', async () => {
      const exp = await running()
      const second = await addContact(db, companyId, 'b@acme.test')
      const viaCompany = await assignVariant(db, exp.id, companyId, null)
      const viaContact = await assignVariant(db, exp.id, companyId, contactId)
      const viaOther = await assignVariant(db, exp.id, companyId, second)
      const viaContactOnly = await assignVariant(db, exp.id, null, second)
      for (const r of [viaCompany, viaContact, viaOther, viaContactOnly]) expect(r.assigned).toBe(true)
      expect(new Set([viaCompany, viaContact, viaOther, viaContactOnly].map((r) => (r.assigned ? r.variant : ''))).size).toBe(1)
      const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.experiment_assignments where experiment_id = $1', [exp.id])
      expect(rows[0].n).toBe(1)
      expect(viaContactOnly).toMatchObject({ company_id: companyId })
    })

    it('rejects a lead that does not exist, and a contact from a different company', async () => {
      const exp = await running()
      expect(await failure(assignVariant(db, exp.id, 999999, null))).toMatchObject({ status: 404 })
      expect(await failure(assignVariant(db, exp.id, null, 999999))).toMatchObject({ status: 404 })
      const other = await addCompany(db, { name: 'Elsewhere' })
      expect((await failure(assignVariant(db, exp.id, other, contactId))).message).toMatch(/does not belong/)
    })

    it('follows a merged company or contact to the surviving lead', async () => {
      const exp = await running()
      const survivor = await addCompany(db, { name: 'Survivor Jewelers' })
      const survivorContact = await addContact(db, survivor, 's@survivor.test')
      await db.query('update lp.companies set merged_into = $2 where id = $1', [companyId, survivor])
      await db.query('update lp.contacts set merged_into = $2 where id = $1', [contactId, survivorContact])
      const viaCompany = await assignVariant(db, exp.id, companyId, null)
      expect(viaCompany).toMatchObject({ assigned: true, company_id: survivor })
      const viaContact = await assignVariant(db, exp.id, null, contactId)
      expect(viaContact).toMatchObject({ assigned: true, company_id: survivor })
      const { rows } = await db.query<{ company_id: number }>('select company_id from lp.experiment_assignments where experiment_id = $1', [exp.id])
      expect(rows).toEqual([{ company_id: survivor }])
    })

    it('honours an assignment made before a merge (the merged-away company had one)', async () => {
      const exp = await running()
      const before = await assignVariant(db, exp.id, companyId, null)
      const survivor = await addCompany(db, { name: 'Survivor Jewelers' })
      await db.query('update lp.companies set merged_into = $2 where id = $1', [companyId, survivor])
      const after = await assignVariant(db, exp.id, survivor, null)
      expect(before.assigned && after.assigned).toBe(true)
      if (before.assigned && after.assigned) {
        expect(after.variant).toBe(before.variant)
        expect(after.existing).toBe(true)
      }
      const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.experiment_assignments where experiment_id = $1', [exp.id])
      expect(rows[0].n).toBe(1)
    })

    it('does not assign a suppressed or do-not-contact lead, and says why', async () => {
      const exp = await running()
      // suppressed: a live suppression on the contact's email
      const suppressed = await addCompany(db, { name: 'Unsub Co' })
      const unsub = await addContact(db, suppressed, 'unsub@unsub.test')
      await db.query(`insert into lp.suppressions (email_norm, reason) values ('unsub@unsub.test', 'unsubscribed')`)
      expect(await assignVariant(db, exp.id, suppressed, unsub)).toMatchObject({ assigned: false, reason: 'suppressed' })
      // do-not-contact company stage, and a do-not-contact contact flag
      const dnc = await addCompany(db, { name: 'DNC Co', stage: 'do_not_contact' })
      expect(await assignVariant(db, exp.id, dnc, null)).toMatchObject({ assigned: false, reason: 'do_not_contact' })
      const flagged = await addCompany(db, { name: 'Flagged Co' })
      const flaggedContact = await addContact(db, flagged, 'f@flagged.test')
      await db.query('update lp.contacts set do_not_contact = true where id = $1', [flaggedContact])
      expect(await assignVariant(db, exp.id, flagged, flaggedContact)).toMatchObject({ assigned: false, reason: 'do_not_contact' })
      const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.experiment_assignments where experiment_id = $1', [exp.id])
      expect(rows[0].n).toBe(0)
    })
  })

  describe('recordOutcome', () => {
    it('accumulates outcomes with upserts and refuses replies above sends', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10 })
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 50, positive_replies: 5 })
      const detail = await getExperimentDetail(db, exp.id)
      expect(detail?.outcomes).toMatchObject([{ variant: 'A', sends: 150, positive_replies: 15 }])
      expect((await failure(recordOutcome(db, 'owner', exp.id, 'B', { sends: 10, positive_replies: 11 }))).status).toBe(400)
    })

    it('rejects a variant that is not configured on the experiment (400) and writes nothing', async () => {
      const exp = await running()
      const e = await failure(recordOutcome(db, 'owner', exp.id, 'Z', { sends: 10 }))
      expect(e.status).toBe(400)
      expect(e.message).toMatch(/Unknown variant "Z"/)
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toEqual([])
    })

    it('accepts outcomes only while the experiment is running', async () => {
      const draft = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 5, name: 'Draft' })
      expect(await failure(recordOutcome(db, 'owner', draft.id, 'A', { sends: 10 }))).toMatchObject({ status: 409 })
      const exp = await running()
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      expect(await failure(recordOutcome(db, 'owner', exp.id, 'A', { sends: 10 }))).toMatchObject({ status: 409 })
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'decided', winner_variant: 'A' })
      expect(await failure(recordOutcome(db, 'owner', exp.id, 'A', { sends: 10 }))).toMatchObject({ status: 409 })
      expect(await failure(recordOutcome(db, 'owner', 999999, 'A', { sends: 10 }))).toMatchObject({ status: 404 })
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toEqual([])
    })

    it('answers non-numeric, fractional, negative and empty deltas with a 400, never NaN or a 500', async () => {
      const exp = await running()
      const bad: Array<Record<string, unknown>> = [
        { sends: 'abc' },
        { sends: Number.NaN },
        { sends: Number.POSITIVE_INFINITY },
        { sends: 1.5 },
        { sends: -1 },
        { sends: 10, positive_replies: 'x' },
        { sends: 10, positive_replies: -2 },
        { sends: {} },
        {},
        { sends: 0, positive_replies: 0 },
      ]
      for (const delta of bad) {
        const e = await failure(recordOutcome(db, 'owner', exp.id, 'A', delta as never))
        expect(e.status, JSON.stringify(delta)).toBe(400)
      }
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toEqual([])
    })

    it('accepts a replies-only delta, and enforces replies <= sends on the cumulative counters', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100 })
      // replies-only: valid because the cumulative replies stay <= cumulative sends
      const o = await recordOutcome(db, 'owner', exp.id, 'A', { positive_replies: 3 })
      expect(o).toMatchObject({ sends: 100, positive_replies: 3 })
      // pushing cumulative replies past cumulative sends is a 400 (the database constraint), and rolls back
      const e = await failure(recordOutcome(db, 'owner', exp.id, 'A', { positive_replies: 98, idempotency_key: 'k-over' }))
      expect(e.status).toBe(400)
      expect(e.message).toMatch(/cannot exceed sends/)
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toMatchObject([{ variant: 'A', sends: 100, positive_replies: 3 }])
      // the failed post did not burn its idempotency key
      const ok = await recordOutcome(db, 'owner', exp.id, 'A', { positive_replies: 1, idempotency_key: 'k-over' })
      expect(ok).toMatchObject({ positive_replies: 4, replayed: false })
      // a replies-only first post for a variant with no sends violates the constraint too
      expect((await failure(recordOutcome(db, 'owner', exp.id, 'B', { positive_replies: 1 }))).status).toBe(400)
    })

    it('logs each outcome delta with the posting actor, naming positive replies', async () => {
      const exp = await running()
      await recordOutcome(db, 'tab', exp.id, 'A', { sends: 40, positive_replies: 4 })
      const { rows } = await db.query<{ actor: string; summary: string; data: { positive_replies: number } }>(
        `select actor, summary, data from lp.events where kind = 'experiment.outcome' and entity_id = $1 order by id desc limit 1`,
        [String(exp.id)],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].actor).toBe('tab')
      expect(rows[0].summary).toContain('+40 sends')
      expect(rows[0].summary).toContain('+4 positive replies')
      expect(rows[0].data.positive_replies).toBe(4)
    })

    it('dedupes a repeated outcome post with the same idempotency key', async () => {
      const exp = await running()
      const first = await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'post-1' })
      const second = await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'post-1' })
      expect(first.replayed).toBe(false)
      expect(second).toMatchObject({ sends: first.sends, positive_replies: first.positive_replies, replayed: true })
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toMatchObject([{ variant: 'A', sends: 100, positive_replies: 10 }])
      // a different key applies again; the same key on another variant is a separate key
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'post-2' })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 7, positive_replies: 1, idempotency_key: 'post-1' })
      const detail = await getExperimentDetail(db, exp.id)
      expect(detail?.outcomes).toMatchObject([
        { variant: 'A', sends: 200, positive_replies: 20 },
        { variant: 'B', sends: 7, positive_replies: 1 },
      ])
    })

    it('applies a delta exactly once when the same keyed post is retried concurrently', async () => {
      const exp = await running()
      const post = () => recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'race' })
      const results = await Promise.all([post(), post(), post(), post()])
      expect(results.filter((r) => !r.replayed)).toHaveLength(1)
      expect((await getExperimentDetail(db, exp.id))?.outcomes).toMatchObject([{ variant: 'A', sends: 100, positive_replies: 10 }])
      const keys = await db.query<{ n: number }>('select count(*)::int as n from lp.experiment_outcome_keys where experiment_id = $1', [exp.id])
      expect(keys.rows[0].n).toBe(1)
      const logged = await db.query<{ n: number }>(`select count(*)::int as n from lp.events where kind = 'experiment.outcome' and entity_id = $1`, [String(exp.id)])
      expect(logged.rows[0].n).toBe(1)
    })

    it('replays a known key (no change) even after the experiment is no longer running', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'late' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      expect(await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10, idempotency_key: 'late' })).toMatchObject({ sends: 100, replayed: true })
      expect(await failure(recordOutcome(db, 'owner', exp.id, 'A', { sends: 1, idempotency_key: 'new' }))).toMatchObject({ status: 409 })
    })
  })

  describe('evaluateExperiment', () => {
    it('auto-decides a significant experiment and reports a close one as not ready', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 1000, positive_replies: 120 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 1000, positive_replies: 80 })
      const ev = await evaluateExperiment(db, ACTOR, exp.id)
      expect(ev.decided).toBe(true)
      expect(ev.pick?.winner).toBe('A')
      const after = await getExperimentDetail(db, exp.id)
      expect(after?.status).toBe('decided')
      expect(after?.winner_variant).toBe('A')

      const exp2 = await running(2)
      await recordOutcome(db, 'owner', exp2.id, 'A', { sends: 1000, positive_replies: 100 })
      await recordOutcome(db, 'owner', exp2.id, 'B', { sends: 1000, positive_replies: 95 })
      const ev2 = await evaluateExperiment(db, ACTOR, exp2.id)
      expect(ev2.decided).toBe(false)
      expect(ev2.eligible).toBe(false)
    })

    it('decides a 3-variant experiment only when the best beats both others', async () => {
      const cfg = { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }] }
      const tied = await running(1, cfg)
      await recordOutcome(db, 'owner', tied.id, 'A', { sends: 1000, positive_replies: 120 })
      await recordOutcome(db, 'owner', tied.id, 'B', { sends: 1000, positive_replies: 115 })
      await recordOutcome(db, 'owner', tied.id, 'C', { sends: 1000, positive_replies: 60 })
      expect((await evaluateExperiment(db, ACTOR, tied.id)).decided).toBe(false)
      expect((await getExperimentDetail(db, tied.id))?.status).toBe('running')

      const clear = await running(2, cfg)
      await recordOutcome(db, 'owner', clear.id, 'A', { sends: 1000, positive_replies: 160 })
      await recordOutcome(db, 'owner', clear.id, 'B', { sends: 1000, positive_replies: 90 })
      await recordOutcome(db, 'owner', clear.id, 'C', { sends: 1000, positive_replies: 60 })
      const ev = await evaluateExperiment(db, ACTOR, clear.id)
      expect(ev).toMatchObject({ decided: true })
      expect(ev.pick?.winner).toBe('A')
      expect(ev.pick?.comparisons).toHaveLength(2)
    })

    it('will not decide while any configured variant is under the minimum sample (a missing outcome row is 0 sends)', async () => {
      const exp = await running(1, { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }] })
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 1000, positive_replies: 160 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 1000, positive_replies: 60 })
      const ev = await evaluateExperiment(db, ACTOR, exp.id)
      expect(ev.decided).toBe(false)
      expect(ev.reason).toMatch(/every variant needs at least 100 sends \(the smallest has 0\)/)
    })

    it('takes a look only at sample milestones (peeking control) and stops after the look budget', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 100, positive_replies: 10 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 100, positive_replies: 9 })
      const first = await evaluateExperiment(db, ACTOR, exp.id)
      expect(first.reason).toMatch(/No clear winner at look 1/)
      expect((await getExperimentDetail(db, exp.id))?.evaluated_looks).toBe(1)
      // evaluating again with no new data tests nothing
      const again = await evaluateExperiment(db, ACTOR, exp.id)
      expect(again.reason).toMatch(/Already evaluated at this sample size; the next look is at 200 sends/)
      // 50 more sends is not a new milestone either
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 50, positive_replies: 7 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 50, positive_replies: 2 })
      expect((await evaluateExperiment(db, ACTOR, exp.id)).reason).toMatch(/Already evaluated/)
      // doubling the smallest arm opens look 2 (and a clear gap decides)
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 50, positive_replies: 20 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 50, positive_replies: 1 })
      const second = await evaluateExperiment(db, ACTOR, exp.id)
      expect(second.decided).toBe(true)
      expect(second.pick?.winner).toBe('A')
      expect(second.pick?.alpha).toBeCloseTo(0.05 / MAX_LOOKS, 12)
      expect((await getExperimentDetail(db, exp.id))?.evaluated_looks).toBe(2)

      // look budget: once all looks are used the auto-winner stops and says to decide by hand
      const spent = await running(2)
      await db.query('update lp.experiments set evaluated_looks = $2 where id = $1', [spent.id, MAX_LOOKS])
      await recordOutcome(db, 'owner', spent.id, 'A', { sends: 100 * 2 ** MAX_LOOKS, positive_replies: 900 })
      await recordOutcome(db, 'owner', spent.id, 'B', { sends: 100 * 2 ** MAX_LOOKS, positive_replies: 100 })
      const done = await evaluateExperiment(db, ACTOR, spent.id)
      expect(done.decided).toBe(false)
      expect(done.reason).toMatch(/decide by hand/)
    })

    it('reports "wins on the numbers" but does not decide when auto_winner is off', async () => {
      const exp = await running(1, { variants: AB, auto_winner: false })
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 1000, positive_replies: 120 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 1000, positive_replies: 80 })
      const ev = await evaluateExperiment(db, ACTOR, exp.id)
      expect(ev).toMatchObject({ eligible: true, decided: false })
      expect((await getExperimentDetail(db, exp.id))?.status).toBe('running')
    })

    it('does not report decided, and logs nothing, when the experiment is paused underneath the decision', async () => {
      const exp = await running()
      await recordOutcome(db, 'owner', exp.id, 'A', { sends: 1000, positive_replies: 120 })
      await recordOutcome(db, 'owner', exp.id, 'B', { sends: 1000, positive_replies: 80 })
      // A concurrent writer pauses the experiment right before the decide statement runs.
      const racing: Db = {
        query: db.query,
        tx: (fn, actor) =>
          db.tx(
            (q) =>
              fn({
                async query(text, params) {
                  if (/set status = 'decided'/.test(text)) {
                    await q.query(`update lp.experiments set status = 'paused' where id = $1`, [exp.id])
                  }
                  return q.query(text, params)
                },
              }),
            actor,
          ),
      }
      const ev = await evaluateExperiment(racing, ACTOR, exp.id)
      expect(ev.decided).toBe(false)
      expect(ev.reason).toMatch(/paused or decided by someone else/)
      const after = await getExperimentDetail(db, exp.id)
      expect(after?.status).toBe('paused')
      expect(after?.winner_variant).toBeNull()
      const logged = await db.query<{ n: number }>(`select count(*)::int as n from lp.events where kind = 'experiment.decided'`)
      expect(logged.rows[0].n).toBe(0)
    })
  })

  describe('the ab_split journey node', () => {
    const node = (config: Record<string, unknown>, paths: { label: string; to: string }[] = [], next: string | null = null) =>
      ({ id: 'split', kind: 'ab_split', config, next, paths })
    const PATHS = [{ label: 'A', to: 'a' }, { label: 'B', to: 'b' }]

    it('is a plain NodeHandler on the plan 3.1 registry (kind ab_split)', () => {
      expect(nodeKinds()).toContain('ab_split')
      expect(getNodeHandler('ab_split')?.kind).toBe('ab_split')
      expect(getNodeHandler('nope')).toBeUndefined()
    })

    it('validate needs experiment_id, a variants list, and one path per variant', () => {
      const h = getNodeHandler('ab_split')!
      expect(h.validate(node({}, PATHS)).join(' | ')).toMatch(/experiment_id/)
      expect(h.validate(node({ experiment_id: 7 }, PATHS)).join(' | ')).toMatch(/variants/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'B'] }, PATHS))).toEqual([])
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'B', 'C'] }, PATHS)).join(' | ')).toMatch(/no path for variant 'C'/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'B'] }, [PATHS[0]])).join(' | ')).toMatch(/no path for variant 'B'/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'B'] }, [...PATHS, { label: 'C', to: 'c' }])).join(' | ')).toMatch(/path 'C' is not one of/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'B'] }, PATHS, 'a')).join(' | ')).toMatch(/not next/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'a:b'] }, PATHS)).join(' | ')).toMatch(/not a valid variant key/)
      expect(h.validate(node({ experiment_id: 7, variants: ['A', 'A'] }, PATHS)).join(' | ')).toMatch(/twice/)
    })

    it('graph validation rejects an ab_split node that leaves a variant without a path', () => {
      const graph = (paths: { label: string; to: string }[]) => ({
        start: 'split',
        nodes: [{ id: 'split', kind: 'ab_split', config: { experiment_id: 1, variants: ['A', 'B'] }, paths }, { id: 'a', kind: 'note' }, { id: 'b', kind: 'note' }],
      })
      expect(() => validateGraph(graph(PATHS))).not.toThrow()
      try {
        validateGraph(graph([PATHS[0]]))
        throw new Error('should have thrown')
      } catch (e) {
        expect(e).toBeInstanceOf(GraphError)
        expect((e as GraphError).errors.join(' ')).toMatch(/no path for variant 'B'/)
      }
    })

    async function ctxFor(exp: { id: number }, lead: { company: number; contact: number | null }, journeyId: number, n = node({ experiment_id: exp.id, variants: ['A', 'B'] }, PATHS)): Promise<NodeContext> {
      const now = new Date('2026-01-05T10:00:00Z')
      return {
        q: db,
        run: { id: 1, journey_id: journeyId, version: 1, company_id: lead.company, contact_id: lead.contact, node_id: 'split', node_entered_at: now, entered_at: now, context: {} },
        node: n,
        graph: { start: 'split', nodes: [] },
        now,
        idempotencyKey: `journey-run:1:split:${now.getTime()}`,
      }
    }
    async function journey(): Promise<number> {
      const jr = await db.query<{ id: number }>(`insert into lp.journeys (name, campaign_id, status) values ('AB journey', $1, 'live') returning id`, [campaignId])
      return jr.rows[0].id
    }
    /** Two companies the hash puts in different variants. */
    async function leadsInEachVariant(expId: number): Promise<{ a: number; b: number }> {
      const out: { a?: number; b?: number } = {}
      for (let i = 0; i < 60 && (!out.a || !out.b); i++) {
        const id = await addCompany(db, { name: `Lead ${i}` })
        const v = variantForBucket(AB, hashBucket(expId, id))
        if (v === 'A' && !out.a) out.a = id
        if (v === 'B' && !out.b) out.b = id
      }
      return { a: out.a as number, b: out.b as number }
    }

    it('routes by the assigned variant: path = variant, recorded in the run context; leads in A and B take different paths', async () => {
      const exp = await running()
      const jid = await journey()
      const leads = await leadsInEachVariant(exp.id)
      const h = getNodeHandler('ab_split')!
      const a = await h.run(await ctxFor(exp, { company: leads.a, contact: null }, jid))
      const b = await h.run(await ctxFor(exp, { company: leads.b, contact: null }, jid))
      expect(a).toMatchObject({ type: 'next', path: 'A', context: { ab_split: { experiment_id: exp.id, variant: 'A' } } })
      expect(b).toMatchObject({ type: 'next', path: 'B', context: { ab_split: { experiment_id: exp.id, variant: 'B' } } })
      expect(a.type === 'next' && b.type === 'next' && a.path !== b.path).toBe(true)
      // the same person (same company, a contact) is routed the same way
      const again = await h.run(await ctxFor(exp, { company: leads.a, contact: await addContact(db, leads.a, 'x@lead.test') }, jid))
      expect(again).toMatchObject({ type: 'next', path: 'A' })
      expect(pickVariant({ ...exp, status: 'running' }, leads.a)).toBe('A')
    })

    it('runs end to end through the journey runner: leads assigned A and B finish on different nodes', async () => {
      const exp = await running()
      const leads = await leadsInEachVariant(exp.id)
      const j = (await runOp(db, 'owner', 'journey_upsert', { name: 'AB flow', campaign_id: campaignId })) as { id: number }
      await runOp(db, 'owner', 'journey_publish', {
        journey_id: j.id,
        graph: {
          start: 'split',
          nodes: [
            { id: 'split', kind: 'ab_split', config: { experiment_id: exp.id, variants: ['A', 'B'] }, paths: PATHS },
            { id: 'a', kind: 'note' },
            { id: 'b', kind: 'note' },
          ],
        },
      })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
      const ended: Record<string, string> = {}
      for (const [name, company] of [['a', leads.a], ['b', leads.b]] as const) {
        const en = (await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: company })) as { results: { run_id: number }[] }
        const runId = en.results[0].run_id
        await advanceRun(db, runId)
        const { rows } = await db.query<{ status: string; node_id: string; context: Record<string, unknown> }>('select status, node_id, context from lp.journey_runs where id = $1', [runId])
        expect(rows[0].status).toBe('done')
        expect(rows[0].context).toMatchObject({ ab_split: { experiment_id: exp.id } })
        ended[name] = rows[0].node_id
      }
      expect(ended).toEqual({ a: 'a', b: 'b' })
    })

    it('waits (does not error) while the experiment is a draft or paused, and resumes when it runs', async () => {
      const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Hold' })
      const jid = await journey()
      const h = getNodeHandler('ab_split')!
      const ctx = await ctxFor(exp, { company: companyId, contact: contactId }, jid)
      const draft = await h.run(ctx)
      expect(draft.type).toBe('wait')
      if (draft.type === 'wait') expect(draft.until.getTime()).toBe(ctx.now.getTime() + AB_WAIT_MINUTES * 60_000)
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      expect((await h.run(ctx)).type).toBe('wait')
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      expect((await h.run(ctx)).type).toBe('next')
    })

    it('a run parked on a paused experiment stays waiting in the runner (no error, no attempts burned)', async () => {
      const exp = await createExperiment(db, ACTOR, { campaign_id: campaignId, step_number: 1, name: 'Park' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      await updateExperiment(db, ACTOR, exp.id, { status: 'paused' })
      const j = (await runOp(db, 'owner', 'journey_upsert', { name: 'AB park', campaign_id: campaignId })) as { id: number }
      await runOp(db, 'owner', 'journey_publish', {
        journey_id: j.id,
        graph: { start: 'split', nodes: [{ id: 'split', kind: 'ab_split', config: { experiment_id: exp.id, variants: ['A', 'B'] }, paths: PATHS }, { id: 'a', kind: 'note' }, { id: 'b', kind: 'note' }] },
      })
      await runOp(db, 'owner', 'journey_set_status', { journey_id: j.id, status: 'live' })
      const en = (await runOp(db, 'owner', 'journey_enroll', { journey_id: j.id, company_id: companyId })) as { results: { run_id: number }[] }
      const runId = en.results[0].run_id
      for (let i = 0; i < 4; i++) await advanceRun(db, runId, new Date(Date.now() + i * 60 * 60_000))
      const { rows } = await db.query<{ status: string; attempts: number; last_error: string | null }>('select status, attempts, last_error from lp.journey_runs where id = $1', [runId])
      expect(rows[0]).toMatchObject({ status: 'waiting', attempts: 0, last_error: null })
      await updateExperiment(db, ACTOR, exp.id, { status: 'running' })
      await advanceRun(db, runId, new Date(Date.now() + 10 * 60 * 60_000))
      const after = await db.query<{ status: string }>('select status from lp.journey_runs where id = $1', [runId])
      expect(after.rows[0].status).toBe('done')
    })

    it('routes every lead to the winner once the experiment is decided, whatever they were assigned', async () => {
      const exp = await running()
      const jid = await journey()
      const leads = await leadsInEachVariant(exp.id)
      const h = getNodeHandler('ab_split')!
      await h.run(await ctxFor(exp, { company: leads.a, contact: null }, jid)) // assigned A before the decision
      await updateExperiment(db, ACTOR, exp.id, { status: 'decided', winner_variant: 'B' })
      const before = await h.run(await ctxFor(exp, { company: leads.a, contact: null }, jid))
      const fresh = await h.run(await ctxFor(exp, { company: await addCompany(db, { name: 'Fresh' }), contact: null }, jid))
      expect(before).toMatchObject({ type: 'next', path: 'B', result: { winner: 'B', assigned_variant: 'A' } })
      expect(fresh).toMatchObject({ type: 'next', path: 'B' })
    })

    it('exits a suppressed or do-not-contact lead instead of splitting it', async () => {
      const exp = await running()
      const jid = await journey()
      const dnc = await addCompany(db, { name: 'DNC', stage: 'do_not_contact' })
      const out = await getNodeHandler('ab_split')!.run(await ctxFor(exp, { company: dnc, contact: null }, jid))
      expect(out).toMatchObject({ type: 'finish', status: 'exited', result: { reason: 'do_not_contact' } })
    })

    it("fails loudly if the experiment's variants are not all covered by the node's paths", async () => {
      const exp = await running(1, { variants: [{ key: 'A', weight: 1 }, { key: 'B', weight: 1 }, { key: 'C', weight: 1 }] })
      const jid = await journey()
      await expect(getNodeHandler('ab_split')!.run(await ctxFor(exp, { company: companyId, contact: null }, jid))).rejects.toThrow(/no path for experiment \d+ variant\(s\) C/)
    })

    it("refuses an experiment that belongs to another campaign's journey", async () => {
      const exp = await running()
      const other = await makeCampaign(db, 'Other')
      const jr = await db.query<{ id: number }>(`insert into lp.journeys (name, campaign_id, status) values ('Other', $1, 'live') returning id`, [other])
      await expect(getNodeHandler('ab_split')!.run(await ctxFor(exp, { company: companyId, contact: null }, jr.rows[0].id))).rejects.toThrow(/belongs to campaign/)
    })
  })
})
