import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import {
  addStatus, archiveCampaign, createCampaign, duplicateCampaign, getCampaign, listCampaigns, makeOwnRules, setStatusActive, updateCampaign,
} from '@/lib/campaigns/store'
import {
  addLeadsByFilter, addLeadsByIds, getCampaignLead, listCampaignLeads, parseLeadPatch, pickWhere, previewPick, removeLeads, updateCampaignLead,
} from '@/lib/campaigns/leads'
import { ruleSetFor, tierCountsFor, verdictsFor, type LiveBackend } from '@/lib/campaigns/evaluator'
import { CampaignError, overridesFromLines, parseCampaignPatch, parsePick, parseTags } from '@/lib/campaigns/types'
import { routeToOp, runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function events(db: TestDb, kind: string) {
  const { rows } = await db.query<{ actor: string; summary: string; data: Record<string, unknown> }>(
    'select actor, summary, data from lp.events where kind = $1 order by id',
    [kind],
  )
  return rows
}

describe('campaigns workspace (real Postgres via PGlite)', () => {
  let db: TestDb
  let gem: number
  let ring: number
  let held: number
  let agency: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com', stage: 'ready' })
    ring = await addCompany(db, { name: 'Ring Bros', state: 'MD', city: 'Towson', domain: 'ringbros.com' })
    held = await addCompany(db, { name: 'Held Jewelers', state: 'VA', domain: 'held.com' })
    agency = await addCompany(db, { name: 'Bot Agency', state: 'MD', segment: 'ai_agency', domain: 'bot.ai' })
    await addContact(db, gem, 'ruth@gemco.com', 'valid', { status: 'valid-ready' })
    await addContact(db, ring, 'sales@ringbros.com', 'unverified', { status: 'role-based-hold', role: true })
    await addContact(db, held, 'look@held.com', 'unverified', { status: 'needs-check' })
  })
  afterAll(async () => {
    await db.close()
  })

  it('migration 0011: statuses come from a table; tags column exists', async () => {
    const { rows } = await db.query<{ id: string }>('select id from lp.campaign_statuses order by sort')
    expect(rows.map((r) => r.id)).toEqual(['draft', 'active', 'paused', 'archived'])
    await expect(db.query(`insert into lp.campaigns (name, status) values ('x', 'bogus')`)).rejects.toThrow()
    // 0020: pool is any lowercase slug (campaign-agnostic), but still not free text.
    await expect(db.query(`insert into lp.campaigns (name, pool) values ('x', 'Not A Pool!')`)).rejects.toThrow()
    await db.query(`update lp.companies set tags = '{vip}' where id = $1`, [gem])
  })

  it('creates a campaign (draft, owner = creator) and logs it', async () => {
    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: '  MD jewelers ', pool: 'jeweler', goal: 'Fall pilot' }, { create: true }) as { name: string })
    expect(c).toMatchObject({ name: 'MD jewelers', pool: 'jeweler', status: 'draft', owner: 'owner', created_by: 'owner', rule_set_id: null })
    const ev = await events(db, 'campaign.created')
    expect(ev.at(-1)?.actor).toBe('owner')
  })

  it('edits only what changed and logs each field old -> new', async () => {
    const c = await createCampaign(db, 'tab', { name: 'Agency partners', pool: 'ai_agency' })
    const r = await updateCampaign(db, 'tab', c.id, { status: 'active', goal: 'Rev-share', name: 'Agency partners' })
    expect(r.changes.map((x) => x.field).sort()).toEqual(['goal', 'status'])
    const ev = (await events(db, 'campaign.updated')).at(-1)!
    expect(ev.actor).toBe('tab')
    expect(ev.summary).toContain('Status: draft → active')
    expect(ev.data.changes).toEqual(expect.arrayContaining([{ field: 'status', from: 'draft', to: 'active' }]))
    const none = await updateCampaign(db, 'tab', c.id, { status: 'active' })
    expect(none.changes).toEqual([])
  })

  it('refuses unknown statuses, owners, fields and rule sets', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Checks' })
    await expect(updateCampaign(db, 'owner', c.id, { status: 'launched' })).rejects.toThrow(/not a campaign status/)
    await expect(updateCampaign(db, 'owner', c.id, { owner: 'nobody' })).rejects.toThrow(/No teammate/)
    await expect(updateCampaign(db, 'owner', c.id, { rule_set_id: 99999 })).rejects.toThrow(/No rule set 99999/)
    expect(() => parseCampaignPatch({ instantly_id: 'x' })).toThrow(CampaignError)
    // 'whales' is a validly-shaped slug (any lowercase slug can be a pool now); parseCampaignPatch no longer rejects it by a fixed list -- only a badly-shaped slug fails here.
    expect(() => parseCampaignPatch({ pool: 'Not A Pool!' })).toThrow(/Pool must be/)
    // Whether 'whales' is a REAL pool is a DB question now (DB-driven behavior): updateCampaign checks lp.pools.
    await expect(updateCampaign(db, 'owner', c.id, { pool: 'whales' })).rejects.toThrow(/Unknown pool/)
    await expect(updateCampaign(db, 'owner', 99999, { name: 'x' })).rejects.toMatchObject({ status: 404 })
  })

  it('statuses are config: add one, use it, switch it off', async () => {
    await addStatus(db, 'owner', { id: 'warming', label: 'Warming up' })
    const c = await createCampaign(db, 'owner', { name: 'Warm', status: 'warming' })
    expect(c.status).toBe('warming')
    await setStatusActive(db, 'owner', 'warming', false)
    await expect(createCampaign(db, 'owner', { name: 'Warm 2', status: 'warming' })).rejects.toThrow(/switched off/)
    await expect(setStatusActive(db, 'owner', 'archived', false)).rejects.toThrow()
    expect((await events(db, 'campaign.status_added')).length).toBe(1)
  })

  it('adds leads by filter (pool/state/status/tag/search), never with an empty filter', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Filter test' })
    await expect(addLeadsByFilter(db, 'owner', c.id, parsePick({}))).rejects.toThrow(/at least one filter/)
    expect(await previewPick(db, c.id, parsePick({ pool: 'jeweler', state: 'md' }))).toEqual({ matching: 2, already: 0 })
    const r = await addLeadsByFilter(db, 'owner', c.id, parsePick({ pool: 'jeweler', state: 'MD' }))
    expect(r).toMatchObject({ added: 2, already: 0 })
    const again = await addLeadsByFilter(db, 'owner', c.id, parsePick({ pool: 'jeweler' }))
    expect(again).toMatchObject({ added: 1, already: 2 })
    expect(await previewPick(db, c.id, parsePick({ contact_status: 'role-based-hold' }))).toEqual({ matching: 1, already: 1 })
    expect((await previewPick(db, c.id, parsePick({ tag: 'VIP' }))).matching).toBe(1)
    expect((await previewPick(db, c.id, parsePick({ q: 'ruth@' }))).matching).toBe(1)
    expect((await previewPick(db, c.id, parsePick({ q: '100%_' }))).matching).toBe(0)
    const ev = (await events(db, 'campaign.leads_added')).at(-1)!
    expect(ev.summary).toContain('by filter (pool Jewelers)')
    expect(() => parsePick({ color: 'red' })).toThrow(/Unknown filter/)
  })

  it('pickWhere numbers its parameters from the given start', () => {
    const w = pickWhere({ pool: 'jeweler', q: 'gem' }, 3)
    expect(w.sql).toContain('$3')
    expect(w.sql).toContain('$4')
    expect(w.params).toEqual(['jeweler', '%gem%'])
  })

  it('adds by hand, reports unknown ids, and removes without touching the lead (held stays held)', async () => {
    const c = await createCampaign(db, 'hermes', { name: 'Hand picked', pool: 'jeweler' })
    const r = await addLeadsByIds(db, 'hermes', c.id, [gem, ring, held, 424242])
    expect(r).toEqual({ added: 3, already: 0, missing: [424242] })
    const rm = await removeLeads(db, 'hermes', c.id, [ring, held])
    expect(rm.removed).toBe(2)
    const st = await db.query<{ status: string }>('select status from lp.contacts where company_id = any($1::bigint[]) order by id', [[ring, held]])
    expect(st.rows.map((x) => x.status)).toEqual(['role-based-hold', 'needs-check'])
    const co = await db.query('select id from lp.companies where id = any($1::bigint[])', [[ring, held]])
    expect(co.rows.length).toBe(2)
    const ev = (await events(db, 'campaign.leads_removed')).at(-1)!
    expect(ev.actor).toBe('hermes')
    expect(ev.summary).toContain('The leads themselves are unchanged')
  })

  it('per-lead overrides, pinned contact, note and tags: validated and logged old -> new', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Overrides' })
    await addLeadsByIds(db, 'owner', c.id, [gem, ring])
    const ringContact = (await db.query<{ id: number }>('select id from lp.contacts where company_id = $1', [ring])).rows[0].id
    await updateCampaignLead(db, 'owner', c.id, gem, parseLeadPatch({ overrides_text: 'firstName = Ruth\nstoreDetail: since 1952', note: 'call first', tags: 'VIP, fall' }))
    let lead = await getCampaignLead(db, c.id, gem)
    expect(lead?.overrides).toEqual({ firstName: 'Ruth', storeDetail: 'since 1952' })
    expect(lead?.tags.sort()).toEqual(['fall', 'vip'])
    await updateCampaignLead(db, 'tab', c.id, gem, parseLeadPatch({ overrides_merge: { storeDetail: null, city: 'Baltimore' } }))
    lead = await getCampaignLead(db, c.id, gem)
    expect(lead?.overrides).toEqual({ firstName: 'Ruth', city: 'Baltimore' })
    const ev = (await events(db, 'campaign.lead_updated')).at(-1)!
    expect(ev.actor).toBe('tab')
    expect(ev.summary).toMatch(/overrides: firstName=Ruth, storeDetail=since 1952 → firstName=Ruth, city=Baltimore/)
    await expect(updateCampaignLead(db, 'owner', c.id, gem, parseLeadPatch({ contact_id: ringContact }))).rejects.toThrow(/doesn't belong/)
    await updateCampaignLead(db, 'owner', c.id, ring, parseLeadPatch({ contact_id: ringContact }))
    expect((await getCampaignLead(db, c.id, ring))?.contact_id).toBe(ringContact)
    expect(() => parseLeadPatch({ overrides: { 'bad key': 'x' } })).toThrow(/not a field name/)
    expect(() => overridesFromLines('no equals sign')).toThrow(/key = value/)
    expect(() => parseTags(['ok', '!!'])).toThrow()
    await expect(updateCampaignLead(db, 'owner', c.id, held, parseLeadPatch({ note: 'x' }))).rejects.toMatchObject({ status: 404 })
  })

  it('duplicates as a draft (with or without leads) and saves templates; archive hides from the list', async () => {
    const src = await createCampaign(db, 'owner', { name: 'Source', pool: 'jeweler', goal: 'g', status: 'active' })
    await addLeadsByIds(db, 'owner', src.id, [gem, ring])
    await updateCampaignLead(db, 'owner', src.id, gem, { overrides: { firstName: 'Ruth' } })
    const copy = await duplicateCampaign(db, 'tab', src.id, {})
    expect(copy.campaign).toMatchObject({ name: 'Source (copy)', status: 'draft', based_on: src.id, goal: 'g', created_by: 'tab' })
    expect(copy.leads_copied).toBe(2)
    expect((await getCampaignLead(db, copy.campaign.id, gem))?.overrides).toEqual({ firstName: 'Ruth' })
    const tpl = await duplicateCampaign(db, 'owner', src.id, { name: 'Jeweler template', withLeads: false, asTemplate: true })
    expect(tpl).toMatchObject({ leads_copied: 0, campaign: { is_template: true } })
    await archiveCampaign(db, 'owner', src.id)
    expect((await getCampaign(db, src.id))?.status).toBe('archived')
    expect((await events(db, 'campaign.archived')).length).toBe(1)
    const visible = await listCampaigns(db)
    expect(visible.find((c) => c.id === src.id)).toBeUndefined()
    expect((await listCampaigns(db, { includeArchived: true })).find((c) => c.id === src.id)?.lead_count).toBe(2)
  })

  it('uses the pool’s rules by default and scores the page’s leads live (one evaluator)', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Scored live', pool: 'jeweler' })
    await addLeadsByIds(db, 'owner', c.id, [gem, ring])
    expect(await ruleSetFor(db, c)).toMatchObject({ scope: 'pool', via: 'pool' })
    const list = await listCampaignLeads(db, c.id)
    for (const r of list.rows) {
      expect(r.verdict?.source).toBe('live')
      expect(['ready_personalized', 'ready_generic', 'parked']).toContain(r.verdict?.tier)
    }
    // A role-based-hold lead is never Ready while owner research is not exhausted (standing rule).
    expect(list.rows.find((r) => r.company_id === ring)?.verdict?.tier).toBe('parked')
  })

  it('agents work campaigns through the ops API (op table and REST aliases); errors keep their status', async () => {
    expect(routeToOp('POST', ['campaigns'])).toEqual({ op: 'create_campaign', args: {} })
    expect(routeToOp('GET', ['campaigns', '7'])).toEqual({ op: 'get_campaign', args: { campaign_id: 7 } })
    expect(routeToOp('POST', ['campaigns', '7', 'update'])).toEqual({ op: 'update_campaign', args: { campaign_id: 7 } })
    expect(routeToOp('POST', ['campaigns', '7', 'leads'])).toEqual({ op: 'add_campaign_leads', args: { campaign_id: 7 } })
    expect(routeToOp('POST', ['campaigns', '7', 'leads', 'remove'])).toEqual({ op: 'remove_campaign_leads', args: { campaign_id: 7 } })
    expect(routeToOp('POST', ['campaigns', '7', 'leads', '12'])).toEqual({ op: 'update_campaign_lead', args: { campaign_id: 7, company_id: 12 } })
    expect(routeToOp('GET', ['campaigns', 'statuses'])).toEqual({ op: 'list_campaign_statuses', args: {} })

    const c = (await runOp(db, 'claude', 'create_campaign', { name: 'From Claude', pool: 'ai_builder' })) as { id: number; created_by: string }
    expect(c.created_by).toBe('claude')
    const u = (await runOp(db, 'claude', 'update_campaign', { campaign_id: c.id, notes: 'builders only' })) as { changes: unknown[] }
    expect(u.changes).toEqual([{ field: 'notes', from: null, to: 'builders only' }])
    expect(await runOp(db, 'claude', 'add_campaign_leads', { campaign_id: c.id, filter: { pool: 'ai_agency' }, preview: true })).toEqual({ matching: 1, already: 0 })
    await runOp(db, 'claude', 'add_campaign_leads', { campaign_id: c.id, company_ids: [agency] })
    const got = (await runOp(db, 'claude', 'get_campaign', { campaign_id: c.id })) as { readiness: { ruleSet: { via: string } } }
    expect(got.readiness.ruleSet.via).toBe('pool')
    await expect(runOp(db, 'claude', 'update_campaign', { campaign_id: c.id, pool: 'other' })).rejects.toMatchObject({ status: 403 })
    const leads = (await runOp(db, 'claude', 'list_campaign_leads', { campaign_id: c.id })) as { total: number }
    expect(leads.total).toBe(1)
    await expect(runOp(db, 'claude', 'update_campaign', { campaign_id: c.id, status: 'launched' })).rejects.toBeInstanceOf(OpsError)
    await expect(runOp(db, 'claude', 'get_campaign', { campaign_id: 999999 })).rejects.toMatchObject({ status: 404 })
    await expect(runOp(db, 'claude', 'update_campaign', { campaign_id: c.id, bogus: 1 })).rejects.toMatchObject({ status: 400 })
  })
})

describe('campaigns workspace + the rules PR (migration 0010, lib/rules)', () => {
  let db: TestDb
  let a: number
  let b: number
  let pool: number
  let template: number
  beforeAll(async () => {
    db = await createTestDb()
    pool = (await db.query<{ id: number }>(`select id from lp.rule_sets where scope = 'pool' and segment = 'jeweler'`)).rows[0].id
    template = (await db.query<{ id: number }>(`select id from lp.rule_sets where scope = 'template' order by id limit 1`)).rows[0].id
    a = await addCompany(db, { name: 'A Jewel', state: 'MD' })
    b = await addCompany(db, { name: 'B Jewel', state: 'MD' })
    await db.query(
      `insert into lp.lead_evaluations (rule_set_id, company_id, tier, reasons, merge, version) values
        ($1, $2, 'ready_personalized', '[]', '{"firstName":"Ann"}', 1),
        ($1, $3, 'parked', '[{"rule":"on_hold","label":"On hold","detail":"role-based-hold","standing":true}]', '{}', 1)`,
      [pool, a, b],
    )
  })
  afterAll(async () => {
    await db.close()
  })

  it('reads stored scores with reasons; counts and the tier filter use them', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Scored', pool: 'jeweler' })
    await addLeadsByIds(db, 'owner', c.id, [a, b])
    expect(await ruleSetFor(db, c)).toMatchObject({ id: pool, via: 'pool' })
    const v = await verdictsFor(db, c, [a, b], null)
    expect(v.verdicts.get(a)).toMatchObject({ tier: 'ready_personalized', merge: { firstName: 'Ann' }, source: 'stored' })
    expect(v.verdicts.get(b)?.reasons[0]).toMatchObject({ rule: 'on_hold', standing: true })
    expect(await tierCountsFor(db, c)).toMatchObject({ ready_personalized: 1, parked: 1, ready_generic: 0, not_scored: 0 })
    expect((await listCampaignLeads(db, c.id, { tier: 'parked' })).rows.map((r) => r.company_id)).toEqual([b])
  })

  it('own rules: a person makes them (a copy, via the rules PR); agents cannot; never shared between campaigns', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Own rules', pool: 'jeweler' })
    await expect(makeOwnRules(db, 'tab', c.id)).rejects.toMatchObject({ status: 403 })
    const r = await makeOwnRules(db, 'owner', c.id)
    const own = r.campaign.rule_set_id!
    expect(own).not.toBe(pool)
    expect(await ruleSetFor(db, r.campaign)).toMatchObject({ id: own, scope: 'campaign', via: 'own' })
    await expect(makeOwnRules(db, 'owner', c.id)).rejects.toMatchObject({ status: 409 })
    expect((await events(db, 'rules.created')).at(-1)?.actor).toBe('owner')

    await expect(updateCampaign(db, 'tab', c.id, { rule_set_id: pool })).rejects.toMatchObject({ status: 403 })
    await expect(updateCampaign(db, 'tab', c.id, { pool: 'other' })).rejects.toThrow(/Only a person/)
    await expect(createCampaign(db, 'tab', { name: 'agent picks rules', rule_set_id: pool })).rejects.toMatchObject({ status: 403 })
    const thief = await createCampaign(db, 'owner', { name: 'Thief' })
    await expect(updateCampaign(db, 'owner', thief.id, { rule_set_id: own })).rejects.toMatchObject({ status: 409 })

    const mine = await duplicateCampaign(db, 'owner', c.id, { asTemplate: true, withLeads: false })
    expect(mine.rules).toBe('copied')
    expect(mine.campaign.rule_set_id).not.toBe(own)
    expect(await ruleSetFor(db, mine.campaign)).toMatchObject({ via: 'own' })
    const agents = await duplicateCampaign(db, 'hermes', c.id, {})
    expect(agents).toMatchObject({ rules: 'pool', campaign: { rule_set_id: null } })

    const picked = await updateCampaign(db, 'owner', thief.id, { rule_set_id: template })
    expect(await ruleSetFor(db, picked.campaign)).toMatchObject({ id: template, via: 'picked' })
    await expect(updateCampaign(db, 'owner', thief.id, { rule_set_id: 999999 })).rejects.toThrow(/No rule set/)
  })

  it('falls back to stored scores if live scoring fails', async () => {
    const c = await createCampaign(db, 'owner', { name: 'Live', pool: 'jeweler' })
    const live: LiveBackend = {
      score: async (_q, _rs, ids) =>
        new Map(ids.map((id) => [id, { company_id: id, contact_id: null, tier: 'ready_generic' as const, batch: 'standard' as const, reasons: [], merge: {}, missing: ['firstName'], source: 'live' as const, stale: false, evaluated_at: null }])),
    }
    expect((await verdictsFor(db, c, [a], live)).verdicts.get(a)).toMatchObject({ tier: 'ready_generic', source: 'live' })
    const broken: LiveBackend = { score: async () => { throw new Error('boom') } }
    expect((await verdictsFor(db, c, [a], broken)).verdicts.get(a)).toMatchObject({ tier: 'ready_personalized', source: 'stored' })
  })
})

describe('the workspace never talks to Instantly', () => {
  it('no campaigns module or page imports the Instantly client or add-leads', () => {
    const root = join(__dirname, '..')
    const files = [
      ...readdirSync(join(root, 'lib', 'campaigns')).map((f) => join(root, 'lib', 'campaigns', f)),
      join(root, 'app', 'actions', 'campaigns.ts'),
      join(root, 'app', 'campaigns', 'page.tsx'),
      join(root, 'app', 'campaigns', '[id]', 'page.tsx'),
    ].filter((f) => !f.endsWith('evaluator-live.ts'))
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/lib\/instantly|INSTANTLY_API_KEY|api\.instantly\.ai/)
    }
  })
})
