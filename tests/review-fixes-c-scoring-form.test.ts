import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => undefined }))
vi.mock('next/navigation', () => ({
  redirect: (u: string) => {
    throw new Error(`REDIRECT ${u}`)
  },
}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => 'owner',
  currentActorId: async () => 'owner',
  currentEmail: async () => null,
}))

import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { ScoringError, getScoreModel, listScoreModels, upsertScoreModel } from '@/lib/scoring/engine'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
import { getLeadProfile } from '@/lib/leads/profile'
import { saveScoreModelRulesAction } from '@/app/actions/scoring'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
  holder.db = db
})
afterAll(async () => {
  holder.db = null
  await db.close()
})

const RULES = [{ rule_key: 'replied', label: 'Replied', event_type: 'reply_received', points: 10 }]

/** Run a server action that ends in redirect(); return the URL it redirected to. */
async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    const m = /^REDIRECT (.*)$/.exec((e as Error).message)
    if (m) return m[1]
    throw e
  }
  throw new Error('expected a redirect')
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

/** A per-campaign model (one model per kind per campaign, so each test gets its own campaign). */
async function newModel(name: string, extra: Record<string, unknown> = {}) {
  const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: `Camp ${name}`, pool: 'jeweler' }, { create: true }) as { name: string })
  return (await runOp(db, 'owner', 'upsert_score_model', {
    name,
    entity: 'contact',
    kind: 'engagement',
    campaign_id: c.id,
    rules: RULES,
    thresholds: [{ key: 'hot', label: 'Hot', min: 10 }],
    max_points: 50,
    ...extra,
  })) as { id: number; max_points: number | null }
}

// Review fix (#74 Medium, Viktor): bad rules crashed the Settings -> Scoring form with a
// 500 page (rules.ts throws a plain Error), and every save wiped max_points because the
// form has no such field. The ops API had the same two problems.
describe('scoring settings: bad input is a message, not a crash', () => {
  it('upsertScoreModel reports malformed rules and thresholds as a ScoringError (400)', async () => {
    await expect(upsertScoreModel(db, 'owner', { name: 'Bad', entity: 'company', kind: 'engagement', rules: [{ label: 'no key' }] })).rejects.toBeInstanceOf(ScoringError)
    await expect(upsertScoreModel(db, 'owner', { name: 'Bad', entity: 'company', kind: 'engagement', rules: RULES, thresholds: [{ key: 'x', min: 'lots' }] })).rejects.toThrow(
      'thresholds[0].min must be a number',
    )
    await expect(upsertScoreModel(db, 'owner', { name: 'Bad', entity: 'company', kind: 'engagement', rules: RULES, max_points: 2.5 })).rejects.toBeInstanceOf(ScoringError)
  })

  it('the ops API answers 400 for malformed rules, not 500', async () => {
    const err = await runOp(db, 'owner', 'upsert_score_model', { name: 'Bad', entity: 'company', kind: 'engagement', rules: 'nope' }).catch((e) => e)
    expect(err).toBeInstanceOf(OpsError)
    expect((err as OpsError).status).toBe(400)
    expect((err as Error).message).toBe('rules must be an array')
  })

  it('the form shows the error inline for bad rules or bad JSON, and saves nothing', async () => {
    const m = await newModel('Form errors')
    const base = { id: String(m.id), name: 'Form errors', entity: 'contact', kind: 'engagement', campaign_id: '' }
    const bad = await redirectOf(saveScoreModelRulesAction(form({ ...base, rules_json: '[{"label":"no key"}]', thresholds_json: '[]' })))
    expect(new URL(bad, 'http://x').searchParams.get('error')).toBe('rules[0].rule_key is required')
    const json = await redirectOf(saveScoreModelRulesAction(form({ ...base, rules_json: JSON.stringify(RULES), thresholds_json: '[{' })))
    expect(new URL(json, 'http://x').searchParams.get('error')).toBe('Thresholds must be valid JSON.')
    const cap = await redirectOf(saveScoreModelRulesAction(form({ ...base, rules_json: JSON.stringify(RULES), thresholds_json: '[]', max_points: 'abc' })))
    expect(new URL(cap, 'http://x').searchParams.get('error')).toContain('max_points must be a positive whole number')
    const after = await getScoreModel(db, m.id)
    expect(after!.max_points).toBe(50)
    expect(after!.thresholds).toEqual([{ key: 'hot', label: 'Hot', min: 10 }])
  })
})

describe('scoring settings: saving never silently wipes the cap or thresholds', () => {
  it('an ops update that leaves out max_points and thresholds keeps them', async () => {
    const m = await newModel('Ops keep')
    await runOp(db, 'owner', 'upsert_score_model', { id: m.id, name: 'Ops keep', entity: 'contact', kind: 'engagement', rules: RULES })
    const after = await getScoreModel(db, m.id)
    expect(after!.max_points).toBe(50)
    expect(after!.thresholds).toEqual([{ key: 'hot', label: 'Hot', min: 10 }])
    // An explicit null still clears the cap.
    await runOp(db, 'owner', 'upsert_score_model', { id: m.id, name: 'Ops keep', entity: 'contact', kind: 'engagement', rules: RULES, max_points: null })
    expect((await getScoreModel(db, m.id))!.max_points).toBeNull()
  })

  it('the form keeps the cap when the field is absent, sets it when filled, clears it when emptied', async () => {
    const m = await newModel('Form keep')
    const base = { id: String(m.id), name: 'Form keep', entity: 'contact', kind: 'engagement', campaign_id: '', rules_json: JSON.stringify(RULES), thresholds_json: '[{"key":"hot","label":"Hot","min":10}]' }
    expect(await redirectOf(saveScoreModelRulesAction(form(base)))).toContain('saved=')
    expect((await getScoreModel(db, m.id))!.max_points).toBe(50)
    await redirectOf(saveScoreModelRulesAction(form({ ...base, max_points: '30' })))
    expect((await getScoreModel(db, m.id))!.max_points).toBe(30)
    await redirectOf(saveScoreModelRulesAction(form({ ...base, max_points: '' })))
    expect((await getScoreModel(db, m.id))!.max_points).toBeNull()
  })
})

// Review fix (#79 Medium, Viktor): the Lead 360 header read whichever lp.scores row was
// updated last for the company -- engagement, fit, per-campaign, or even a contact row
// carrying the company_id -- so "Score N" changed meaning between visits.
describe('Lead 360 header score comes from one fixed model', () => {
  it('shows the default company Engagement score, not the most recently updated row', async () => {
    const co = await addCompany(db, { name: 'Header Score Co' })
    const ct = await addContact(db, co, 'owner@headerscore.example')
    const models = await listScoreModels(db, { active_only: true })
    const eng = models.find((x) => x.kind === 'engagement' && x.entity === 'company' && x.campaign_id == null)!
    const fit = models.find((x) => x.kind === 'fit' && x.entity === 'company' && x.campaign_id == null)!
    const contactModel = await newModel('Contact engagement', { max_points: null })

    // Engagement 12 (oldest), then a newer Fit 40, then a newer contact-level row with the company_id.
    await db.query(`insert into lp.scores (model_id, company_id, contact_id, score, updated_at) values ($1, $2, null, 12, now() - interval '2 days')`, [eng.id, co])
    await db.query(`insert into lp.scores (model_id, company_id, contact_id, score, updated_at) values ($1, $2, null, 40, now() - interval '1 day')`, [fit.id, co])
    await db.query(`insert into lp.scores (model_id, company_id, contact_id, score, updated_at) values ($1, $2, $3, 99, now())`, [contactModel.id, co, ct])

    const p = await getLeadProfile(db, co)
    expect(p!.score.row?.score).toBe(12)
    expect(p!.score.model).toMatchObject({ id: Number(eng.id), kind: 'engagement' })
  })

  it('a lead the header model never scored reads null ("Not scored yet"), even if another model scored it', async () => {
    const co = await addCompany(db, { name: 'Fit Only Co' })
    const fit = (await listScoreModels(db, { active_only: true })).find((x) => x.kind === 'fit' && x.entity === 'company' && x.campaign_id == null)!
    await db.query(`insert into lp.scores (model_id, company_id, contact_id, score) values ($1, $2, null, 25)`, [fit.id, co])
    const p = await getLeadProfile(db, co)
    expect(p!.score.row).toBeNull()
    expect(p!.score.model?.kind).toBe('engagement')
  })
})
