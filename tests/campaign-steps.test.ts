import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { copyChecks, fillTemplate, wordCount, endsWithQuestion } from '@/lib/campaign-steps/render'
import { createStep, updateStep, deleteStep, reorderSteps, listSteps, parseStepInput, StepsError } from '@/lib/campaign-steps/store'
import { previewLead } from '@/lib/campaign-steps/preview'
import { linkInstantly, requestPush, cancelPush, parseInstantlyId } from '@/lib/campaign-steps/instantly'
import { DEFAULT_FIELDS } from '@/lib/campaign-steps/adapter'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { GET as humanGet, POST as humanPost, PATCH as humanPatch, PUT as humanPut } from '@/app/api/campaign-steps/[campaignId]/[[...path]]/route'
import { GET as opsGet, POST as opsPost, PUT as opsPut } from '@/app/api/ops/campaign-steps/[campaignId]/[[...path]]/route'

const IID = '11111111-2222-4333-8444-555555555555'
const GOOD_BODY =
  'Hi {{firstName}}, I run a small studio that helps independent jewelers in {{state}} turn walk-in browsers into booked appointments. ' +
  'We set it up in a week, it costs nothing until it books you a sale, and you keep every customer. ' +
  'I noticed {{personalization}} and thought it could fit {{companyName}} well this season. ' +
  'Would it be worth a ten minute call next week to see if it fits your store?'

async function campaign(db: TestDb, name: string): Promise<number> {
  const { rows } = await db.query<{ id: number }>(`insert into lp.campaigns (name, pool) values ($1, 'jeweler') returning id`, [name])
  return rows[0].id
}
async function events(db: TestDb, kind: string) {
  const { rows } = await db.query<{ actor: string; summary: string; data: { changes: { field: string; old: unknown; new: unknown }[] } }>(
    `select actor, summary, data from lp.events where kind = $1 order by id`,
    [kind],
  )
  return rows
}
const req = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
  const r = new Request(`http://x${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers }) as Request & { nextUrl: URL }
  r.nextUrl = new URL(`http://x${url}`)
  return r
}
const ctx = (campaignId: number, path: string[] = []) => ({ params: Promise.resolve({ campaignId: String(campaignId), path }) })

describe('copy checks and filling (pure)', () => {
  it('fills placeholders case-insensitively and leaves unknown or empty ones visible', () => {
    const f = fillTemplate('Hi {{ FirstName }}, {{city}} / {{nope}}', {
      firstName: { value: 'Dana', source: 'lead', real: true },
      city: { value: null, source: null, real: false },
    })
    expect(f.text).toBe('Hi Dana, {{city}} / {{nope}}')
    expect(f.leftovers).toEqual(['city', 'nope'])
    expect(f.unknown).toEqual(['nope'])
  })
  it('warns (never blocks) on links, length and a missing question', () => {
    expect(copyChecks(GOOD_BODY.replace(/\{\{\w+\}\}/g, 'x'))).toEqual([])
    const codes = (s: string) => copyChecks(s).map((w) => w.code)
    expect(codes('See https://gem.co for more. Thanks.')).toEqual(expect.arrayContaining(['has_link', 'too_short', 'no_question']))
    expect(codes('Visit gemco.com today?')).toContain('has_link')
    expect(codes(Array(90).fill('word').join(' ') + '?')).toEqual(['too_long'])
    expect(codes('Hi {{firstName}}?')).toContain('leftover')
    expect(wordCount('one two  three')).toBe(3)
    expect(endsWithQuestion('Worth a call?" ')).toBe(true)
  })
  it('refuses unknown or bad step fields', () => {
    expect(() => parseStepInput({ subjet: 'x' }, { partial: true })).toThrow(/Unknown field "subjet"/)
    expect(() => parseStepInput({ delay_days: -1 }, { partial: true })).toThrow(StepsError)
    expect(() => parseStepInput({ variant: '!!' }, { partial: true })).toThrow(/variant/)
    expect(() => parseStepInput({ delay_days: 2 }, { partial: false })).toThrow(/subject or a body/)
  })
  it('reads an Instantly id or link', () => {
    expect(parseInstantlyId(IID.toUpperCase())).toBe(IID)
    expect(parseInstantlyId(`https://app.instantly.ai/app/campaign/${IID}/analytics`)).toBe(IID)
    expect(parseInstantlyId('')).toBeNull()
    expect(() => parseInstantlyId('abc')).toThrow(StepsError)
  })
})

describe('campaign steps (real Postgres via PGlite)', () => {
  let db: TestDb
  let camp: number
  let gem: number
  let ring: number
  let bare: number
  const fetchSpy = vi.fn(async () => new Response('{}'))

  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
    vi.stubGlobal('fetch', fetchSpy)
    // Once 0010 (lead rules) is merged, the fields come from the rule sets: pin them to the
    // same five fields so this suite reads the same before and after that merge.
    const rs = await db.query<{ t: string | null }>(`select to_regclass('lp.rule_sets')::text as t`)
    if (rs.rows[0].t) await db.query(`update lp.rule_sets set fields = $1::jsonb, updated_by = 'owner'`, [JSON.stringify(DEFAULT_FIELDS)])
    camp = await campaign(db, 'MD jewelers fall')
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com' })
    const gemCt = await addContact(db, gem, 'dana@gemco.com', 'valid')
    await db.query(`update lp.contacts set first_name = 'Dana', personalization = 'your bridal wall on Instagram' where id = $1`, [gemCt])
    ring = await addCompany(db, { name: 'Ring Bros', state: 'MD', city: 'Towson', domain: 'ringbros.com' })
    const ringCt = await addContact(db, ring, 'sales@ringbros.com', 'valid', { role: true })
    // No first name on the contact: the enrichment fact fills it; the override beats both for personalization.
    await db.query(
      `insert into lp.enrichment (company_id, contact_id, field, value, confidence, method) values
         ($1, $2, 'first_name', 'Sam', 'high', 'agent'), ($1, null, 'first_name', 'Old', 'low', 'agent'),
         ($1, null, 'personalization', 'from enrichment', 'medium', 'agent')`,
      [ring, ringCt],
    )
    bare = await addCompany(db, { name: 'Bare Gems', state: null })
    await addContact(db, bare, 'hello@baregems.com', 'unverified')
    await db.query(
      `insert into lp.campaign_leads (campaign_id, company_id, overrides) values ($1, $2, '{}'), ($1, $3, '{"Personalization": "your 40-year anniversary"}'), ($1, $4, '{}')`,
      [camp, gem, ring, bare],
    )
  })
  afterEach(() => fetchSpy.mockClear())
  afterAll(async () => {
    vi.unstubAllGlobals()
    await db.close()
  })

  it('adds, edits, reorders and deletes steps, logging actor and old -> new each time', async () => {
    const s1 = await createStep(db, 'owner', camp, parseStepInput({ subject: 'Quick question, {{firstName}}', body: GOOD_BODY }, { partial: false }))
    expect(s1).toMatchObject({ step_number: 1, variant: 'A', delay_days: 0, created_by: 'owner' })
    const s2 = await createStep(db, 'tab', camp, { subject: 'Following up', body: 'Any thoughts, {{firstName}}?' })
    expect(s2).toMatchObject({ step_number: 2, delay_days: 3, created_by: 'tab' })
    const b = await createStep(db, 'owner', camp, { step_number: 1, variant: 'B', subject: 'For {{companyName}}', body: GOOD_BODY })
    expect(b.step_number).toBe(1)
    await expect(createStep(db, 'owner', camp, { step_number: 1, variant: 'b', subject: 'dup' })).rejects.toMatchObject({ status: 409 })

    const { changes } = await updateStep(db, 'owner', camp, s2.id, { delay_days: 5, subject: 'Following up' })
    expect(changes).toEqual([{ field: 'delay_days', old: 3, new: 5 }])
    const [edit] = await events(db, 'campaign.step_edited')
    expect(edit).toMatchObject({ actor: 'owner' })
    expect(edit.summary).toMatch(/delay_days "3" → "5"/)
    expect(edit.data.changes).toEqual([{ field: 'delay_days', old: 3, new: 5 }])

    const after = await reorderSteps(db, 'owner', camp, [2, 1])
    expect(after.map((s) => [s.step_number, s.variant, s.subject])).toEqual([
      [1, 'A', 'Following up'],
      [2, 'A', 'Quick question, {{firstName}}'],
      [2, 'B', 'For {{companyName}}'],
    ])
    expect((await events(db, 'campaign.steps_reordered'))[0].data.changes).toEqual([
      { field: 'step_number', old: 2, new: 1 },
      { field: 'step_number', old: 1, new: 2 },
    ])
    await expect(reorderSteps(db, 'owner', camp, [1])).rejects.toThrow(/each current step number once/)

    await deleteStep(db, 'owner', camp, b.id)
    const [del] = await events(db, 'campaign.step_deleted')
    expect(del.data.changes.find((c) => c.field === 'subject')).toEqual({ field: 'subject', old: 'For {{companyName}}', new: null })
    expect((await listSteps(db, camp)).length).toBe(2)
    expect((await events(db, 'campaign.step_added')).map((e) => e.actor)).toEqual(['owner', 'tab', 'owner'])
  })

  it('previews every step for a lead: override → lead → enrichment → fallback, and flags what is missing', async () => {
    const p = await previewLead(db, camp, gem)
    const v = Object.fromEntries(p.fields.map((f) => [f.name, [f.value, f.from]]))
    expect(v.firstName).toEqual(['Dana', 'lead'])
    expect(v.personalization).toEqual(['your bridal wall on Instagram', 'lead'])
    expect(p.outlook).toBe('ready_personalized')
    expect(p.steps[1].body.text).toContain('Hi Dana, I run a small studio')
    expect(p.steps[1].body.text).not.toMatch(/\{\{/)

    const r = await previewLead(db, camp, ring)
    const rv = Object.fromEntries(r.fields.map((f) => [f.name, [f.value, f.from]]))
    expect(rv.firstName).toEqual(['Sam', 'enrichment']) // high-confidence, contact-specific fact beats the low one
    expect(rv.personalization).toEqual(['your 40-year anniversary', 'override'])

    // Bare Gems: no name (fallback "there"), no personalization (required, no fallback), no state.
    const g = await previewLead(db, camp, bare)
    const gv = Object.fromEntries(g.fields.map((f) => [f.name, [f.value, f.from]]))
    expect(gv.firstName).toEqual(['there', 'fallback'])
    expect(g.missing_required).toEqual(['personalization'])
    expect(g.leftovers).toEqual(expect.arrayContaining(['state', 'personalization']))
    expect(g.outlook).toBe('parked')
    expect(g.outlook_why.join(' ')).toMatch(/generic copy/)
    expect(g.steps[1].warnings.map((w) => w.code)).toContain('leftover')
    expect(g.steps[0].body.text).toBe('Any thoughts, there?')
  })

  it('links Instantly (a person only) and turns a push into a pending request: no Instantly call, ever', async () => {
    await expect(linkInstantly(db, 'tab', camp, IID)).rejects.toMatchObject({ status: 403 })
    await expect(requestPush(db, 'owner', camp, {})).rejects.toMatchObject({ status: 409 })
    const l = await linkInstantly(db, 'owner', camp, IID)
    expect(l.changed).toBe(true)
    expect((await events(db, 'campaign.instantly_linked'))[0].data.changes).toEqual([{ field: 'instantly_campaign_id', old: null, new: IID }])

    const r = await requestPush(db, 'tab', camp, { what: 'steps_and_leads', note: 'ready to go' })
    expect(r).toMatchObject({ status: 'pending', requested_by: 'tab', instantly_campaign_id: IID })
    expect(r.payload.lead_count).toBe(3)
    expect(r.payload.steps).toHaveLength(2)
    await expect(requestPush(db, 'owner', camp, {})).rejects.toMatchObject({ status: 409 })
    // An agent can never approve one, not even by writing the row directly.
    await expect(
      db.query(`update lp.campaign_instantly_requests set status = 'approved', decided_by = 'tab' where id = $1`, [r.id]),
    ).rejects.toThrow(/only a human/)
    await expect(cancelPush(db, 'hermes', camp, r.id)).rejects.toMatchObject({ status: 403 })
    expect((await cancelPush(db, 'tab', camp, r.id)).status).toBe('cancelled')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('serves the same contract to people and to agents (ops token), logging the right actor', async () => {
    const c2 = await campaign(db, 'Route test')
    const created = await humanPost(req('POST', `/api/campaign-steps/${c2}`, { subject: 'Hi {{firstName}}', body: 'Worth a look?' }), ctx(c2))
    expect(created.status).toBe(201)
    const step = (await created.json()).step
    const patched = await humanPatch(req('PATCH', `/api/campaign-steps/${c2}/${step.id}`, { body: 'Worth a quick look?' }), ctx(c2, [String(step.id)]))
    expect((await patched.json()).changes).toEqual([{ field: 'body', old: 'Worth a look?', new: 'Worth a quick look?' }])
    const got = await (await humanGet(req('GET', `/api/campaign-steps/${c2}`), ctx(c2))).json()
    expect(got.steps[0].warnings.map((w: { code: string }) => w.code)).toEqual(expect.arrayContaining(['too_short']))
    expect((await humanGet(req('GET', `/api/campaign-steps/999999`), ctx(999999))).status).toBe(404)
    expect((await humanPut(req('PUT', `/api/campaign-steps/${c2}/instantly`, { instantly_campaign_id: 'nope' }), ctx(c2, ['instantly']))).status).toBe(400)
    const prev = await humanGet(req('GET', `/api/campaign-steps/${camp}/preview?lead=${gem}`), ctx(camp, ['preview']))
    expect((await prev.json()).preview.lead.company_name).toBe('Gem Co')

    process.env.OPS_AGENT_TOKENS = 'tab:' + 't'.repeat(32)
    const auth = { authorization: 'Bearer ' + 't'.repeat(32) }
    expect((await opsGet(req('GET', `/api/ops/campaign-steps/${c2}`), ctx(c2))).status).toBe(401)
    const ag = await opsPost(req('POST', `/api/ops/campaign-steps/${c2}`, { subject: 'Agent step', body: 'Hello?' }, auth), ctx(c2))
    expect(ag.status).toBe(201)
    expect((await ag.json()).step.created_by).toBe('tab')
    expect((await opsPut(req('PUT', `/api/ops/campaign-steps/${c2}/instantly`, { instantly_campaign_id: IID }, auth), ctx(c2, ['instantly']))).status).toBe(403)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
