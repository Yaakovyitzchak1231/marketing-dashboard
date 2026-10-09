import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { evaluateLead, type LeadFacts, type RuleSetLike } from '@/lib/rules/evaluate'
import { parseRuleDoc, RulesError, type Requirement } from '@/lib/rules/schema'
import { ruleDocFromForm } from '@/lib/rules/form'
import {
  applyProposal,
  createRuleSet,
  getRuleSet,
  listProposals,
  listRuleSets,
  ruleSetForCampaign,
  saveRuleSet,
} from '@/lib/rules/store'
import { runRecompute, tierCounts } from '@/lib/rules/recompute'
import { leadReadiness, overviewReadiness } from '@/lib/rules/readiness'
import { setOwnerResearchExhausted } from '@/lib/rules/owner-research'
import { buildAddPreview, toAddLead } from '@/lib/instantly/add-leads'
import { runOp, routeToOp } from '@/lib/ops/dispatch'

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('next/server', async (orig) => ({ ...(await orig<typeof import('next/server')>()), after: () => undefined }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { PUT as putRules } from '@/app/api/rules/[id]/route'
import { GET as listRulesRoute } from '@/app/api/rules/route'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const NOW = new Date('2026-10-09T12:00:00Z')
const days = (n: number) => new Date(NOW.getTime() - n * 86_400_000)

function lead(over: Partial<LeadFacts['contacts'][number]> = {}, facts: LeadFacts['facts'] = [], co: Partial<LeadFacts['company']> = {}): LeadFacts {
  return {
    company: {
      id: 1, name: 'Gem Co', segment: 'jeweler', vertical: 'independent jeweler', website_domain: 'gem.co', phone_e164: null, city: 'Baltimore', state: 'MD',
      owner_name: null, stage: 'new', research_status: 'researched', last_researched_at: days(10), owner_research_exhausted_at: null, ...co,
    },
    contacts: [
      {
        id: 10, email_norm: 'ruth@gem.co', first_name: 'Ruth', last_name: null, title: null, phone_e164: null, is_role_address: false, email_source: 'website',
        name_confidence: 'high', status: 'new', verification_status: 'valid', verified_at: days(5), personalization: null, do_not_contact: false, touched: false, ...over,
      },
    ],
    facts,
  }
}
const rs = (requirements: Requirement[], fields: RuleSetLike['fields'] = []): RuleSetLike => ({ id: 1, version: 1, requirements, fields })
const EMAIL_VALID: Requirement = { id: 'r-email', enabled: true, field: 'contact.verification_status', op: 'in', value: ['valid'] }

describe('the evaluator (pure)', () => {
  it('Ready-personalized when every required field has a real value; Ready-generic when one is missing; fallback never counts', () => {
    const fields: RuleSetLike['fields'] = [
      { id: 'f1', name: 'firstName', source: 'contact.first_name', required: false, fallback: 'there', min_confidence: 'medium', enabled: true },
      { id: 'f2', name: 'opener', source: 'enrichment:custom_design', required: true, fallback: 'your store', enabled: true },
    ]
    const withFact = evaluateLead(lead({}, [{ contact_id: null, field: 'custom_design', value: 'Makes custom rings', confidence: 'high', last_checked_at: days(30) }]), rs([EMAIL_VALID], fields), NOW)
    expect(withFact.tier).toBe('ready_personalized')
    expect(withFact.merge).toEqual({ firstName: 'Ruth', opener: 'Makes custom rings' })
    const without = evaluateLead(lead(), rs([EMAIL_VALID], fields), NOW)
    expect(without.tier).toBe('ready_generic')
    expect(without.missing).toEqual(['opener'])
    expect(without.merge.opener).toBe('your store')
    const lowName = evaluateLead(lead({ name_confidence: 'low' }), rs([EMAIL_VALID], fields), NOW)
    expect(lowName.merge.firstName).toBe('there')
  })

  it('parks with every failed rule named: field + condition, confidence, fact age', () => {
    const reqs: Requirement[] = [
      EMAIL_VALID,
      { id: 'r-type', enabled: true, field: 'enrichment:business_type', op: 'eq', value: 'independent jeweler', max_age_days: 365 },
      { id: 'r-name', enabled: true, field: 'contact.first_name', op: 'present', min_confidence: 'medium' },
      { id: 'r-off', enabled: false, field: 'contact.title', op: 'present' },
    ]
    const v = evaluateLead(
      lead({ verification_status: 'catch_all', name_confidence: 'low' }, [{ contact_id: null, field: 'business_type', value: 'Independent Jeweler', confidence: 'high', last_checked_at: days(400) }]),
      rs(reqs),
      NOW,
    )
    expect(v.tier).toBe('parked')
    expect(v.reasons.map((r) => r.rule)).toEqual(['r-email', 'r-type', 'r-name'])
    expect(v.reasons[1].detail).toMatch(/not checked in the last 365 days/)
    expect(v.reasons[2].detail).toMatch(/confidence below medium/)
    const fresh = evaluateLead(lead({}, [{ contact_id: null, field: 'business_type', value: 'Independent Jeweler', confidence: 'high', last_checked_at: days(3) }]), rs(reqs.slice(0, 2)), NOW)
    expect(fresh.tier).toBe('ready_generic')
  })

  it('standing rules cannot be edited away: holds, unverified, invalid, do-not-contact, already sent', () => {
    const none = rs([])
    expect(evaluateLead(lead({ status: 'needs-check' }), none, NOW).reasons[0].rule).toBe('on_hold')
    expect(evaluateLead(lead({ status: 'role-based-hold' }), none, NOW).reasons[0].rule).toBe('on_hold')
    expect(evaluateLead(lead({ verification_status: 'unverified' }), none, NOW).reasons[0].rule).toBe('not_verified')
    expect(evaluateLead(lead({ verification_status: 'invalid' }), none, NOW).reasons[0].rule).toBe('invalid')
    expect(evaluateLead(lead({ do_not_contact: true }), none, NOW).reasons[0].rule).toBe('do_not_contact')
    expect(evaluateLead(lead({ status: 'in-Instantly' }), none, NOW).reasons[0].rule).toBe('already_in_campaign')
    expect(evaluateLead(lead({ touched: true }), none, NOW).reasons[0].standing).toBe(true)
  })

  it('role-based-hold is released only after owner research is exhausted: Ready-generic, role-inbox batch, no names', () => {
    const fields: RuleSetLike['fields'] = [
      { id: 'f1', name: 'firstName', source: 'contact.first_name', required: true, fallback: null, enabled: true },
      { id: 'f2', name: 'company', source: 'company.name', required: false, fallback: null, enabled: true },
    ]
    const held = lead({ status: 'role-based-hold', is_role_address: true, email_norm: 'info@gem.co' })
    expect(evaluateLead(held, rs([EMAIL_VALID], fields), NOW).tier).toBe('parked')
    const released = evaluateLead({ ...held, company: { ...held.company, owner_research_exhausted_at: days(1) } }, rs([EMAIL_VALID], fields), NOW)
    expect(released.tier).toBe('ready_generic')
    expect(released.batch).toBe('role-inbox')
    expect(released.merge).toEqual({ company: 'Gem Co' })
    // needs-check is never released
    const nc = lead({ status: 'needs-check' }, [], { owner_research_exhausted_at: days(1) })
    expect(evaluateLead(nc, rs([]), NOW).tier).toBe('parked')
  })

  it('picks the best contact: a named inbox beats info@', () => {
    const l = lead()
    l.contacts.unshift({ ...l.contacts[0], id: 9, email_norm: 'info@gem.co', is_role_address: true, first_name: null })
    const v = evaluateLead(l, rs([EMAIL_VALID]), NOW)
    expect(v.contact_id).toBe(10)
    expect(v.batch).toBe('standard')
  })
})

describe('rule documents', () => {
  it('validates fields, conditions, values, confidence and age limits', () => {
    expect(() => parseRuleDoc({ name: 'x', requirements: [{ field: 'contact.nope', op: 'present' }], fields: [] })).toThrow(RulesError)
    expect(() => parseRuleDoc({ name: 'x', requirements: [{ field: 'contact.verification_status', op: 'in', value: ['valid', 'great'] }], fields: [] })).toThrow(/not a Email status/)
    expect(() => parseRuleDoc({ name: 'x', requirements: [{ field: 'contact.title', op: 'present', min_confidence: 'high' }], fields: [] })).toThrow(/no confidence/)
    expect(() => parseRuleDoc({ name: 'x', requirements: [], fields: [{ name: 'bad name', source: 'company.name' }] })).toThrow(/letter/)
    const d = parseRuleDoc({ name: 'ok', requirements: [{ field: 'enrichment:business_type', op: 'eq', value: 'independent jeweler', max_age_days: '180' }], fields: [] })
    expect(d.requirements[0]).toMatchObject({ field: 'enrichment:business_type', op: 'eq', value: 'independent jeweler', max_age_days: 180, enabled: true })
  })

  it('the Rules page form: edits, the blank add row, and move / remove intents', () => {
    const form: Record<string, string> = {
      name: 'Jewelers', 'req.count': '2',
      'req.0.id': 'a', 'req.0.enabled': 'on', 'req.0.field': 'contact.verification_status', 'req.0.op': 'in', 'req.0.value': 'valid, catch_all',
      'req.1.id': 'b', 'req.1.field': 'contact.title', 'req.1.op': 'present',
      'req.new.field': 'company.state', 'req.new.op': 'eq', 'req.new.value': 'MD',
      'fld.count': '0', intent: 'req-up:1',
    }
    const { doc } = ruleDocFromForm((k) => form[k] ?? '')
    expect(doc.requirements.map((r) => r.id)).toEqual(['b', 'a', ''])
    expect(doc.requirements[1].enabled).toBe(true)
    expect(doc.requirements[0].enabled).toBe(false)
    expect(doc.requirements[2]).toMatchObject({ field: 'company.state', enabled: true })
    const parsed = parseRuleDoc(doc)
    expect(parsed.requirements[1].value).toEqual(['valid', 'catch_all'])
  })
})

describe('lead rules in the database (real Postgres via PGlite)', () => {
  let db: TestDb
  const co: Record<string, number> = {}
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
    co.ruth = await addCompany(db, { name: 'Ruth Gems', domain: 'ruth.com' })
    await addContact(db, co.ruth, 'ruth@ruth.com', 'valid')
    await db.query("update lp.contacts set first_name = 'Ruth', personalization = 'Loved your bridal line' where email_norm = 'ruth@ruth.com'")
    co.catchall = await addCompany(db, { name: 'Maybe Gems', domain: 'maybe.com' })
    await addContact(db, co.catchall, 'hi@maybe.com', 'catch_all')
    co.role = await addCompany(db, { name: 'Role Only', domain: 'role.com' })
    await addContact(db, co.role, 'info@role.com', 'valid', { status: 'role-based-hold', role: true })
    co.builder = await addCompany(db, { name: 'Bot Builders', domain: 'bots.dev', segment: 'ai_builder' })
    await addContact(db, co.builder, 'sam@bots.dev', 'valid')
  })
  afterAll(async () => {
    await db.close()
  })

  it('migration 0010 seeds a default, four pools (with ai_builder) and a template, and queues a first scoring', async () => {
    const sets = await listRuleSets(db)
    expect(sets.map((s) => `${s.scope}:${s.segment ?? ''}`)).toEqual(['default:', 'pool:jeweler', 'pool:ai_agency', 'pool:ai_builder', 'pool:other', 'template:'])
    const { rows } = await db.query<{ n: number }>("select count(*)::int as n from lp.rule_recompute where status = 'queued'")
    expect(rows[0].n).toBe(5)
    const { rows: fresh } = await db.query<{ last_checked_at: Date | null }>('select last_checked_at from lp.enrichment limit 1')
    expect(fresh).toEqual([])
  })

  it('a campaign uses its own rules, else its pool, else the default (and future campaigns get them for free)', async () => {
    expect((await ruleSetForCampaign(db, 'never-seen')).scope).toBe('default')
    await db.query("insert into lp.campaign_meta (campaign_id, segment) values ('camp-j', 'jeweler')")
    expect((await ruleSetForCampaign(db, 'camp-j')).segment).toBe('jeweler')
    expect((await ruleSetForCampaign(db, 'c:7', 'ai_builder')).segment).toBe('ai_builder')
    const jewel = (await listRuleSets(db)).find((s) => s.segment === 'jeweler')!
    const own = await createRuleSet(db, 'owner', { scope: 'campaign', campaign_id: 'camp-j', campaign_name: 'Jewelers test', from_id: jewel.id })
    expect((await ruleSetForCampaign(db, 'camp-j')).id).toBe(own.id)
    await expect(createRuleSet(db, 'owner', { scope: 'campaign', campaign_id: 'camp-j', from_id: jewel.id })).rejects.toThrow(/already has/)
  })

  it('scores every lead in batches; overview, lead page and stored counts agree', async () => {
    const r = await runRecompute(db, { budgetMs: 30_000, batch: 2 })
    expect(r.more).toBe(false)
    const ov = await overviewReadiness(db)
    expect(ov).toMatchObject({ personalized: 1, generic: 1, parked: 2, scored: 4, companies: 4, rescoring: false })
    expect(ov!.topReasons.map((x) => x.rule).sort()).toEqual(['on_hold', 'r-email-valid'])
    const page = await leadReadiness(db, co.ruth)
    expect(page.map((p) => p.verdict.tier)).toEqual(['ready_personalized', 'ready_personalized'])
  })

  it('saving rules (humans only) logs old -> new and re-scores: allowing catch-all makes Maybe Gems Ready', async () => {
    const jewel = (await listRuleSets(db)).find((s) => s.segment === 'jeweler')!
    const doc = { name: jewel.name, requirements: jewel.requirements.map((r) => ({ ...r, value: ['valid', 'catch_all'] })), fields: jewel.fields }
    await expect(saveRuleSet(db, 'hermes', jewel.id, doc)).rejects.toThrow(/Only a person/)
    await expect(db.query("update lp.rule_sets set name = 'x', updated_by = 'hermes' where id = $1", [jewel.id])).rejects.toThrow(/only a human/)
    const out = await saveRuleSet(db, 'owner', jewel.id, doc, { base_version: jewel.version })
    expect(out.changes).toEqual([{ what: 'requirement value', item: expect.stringContaining('r-email-valid'), old: ['valid'], new: ['valid', 'catch_all'] }])
    await expect(saveRuleSet(db, 'owner', jewel.id, doc, { base_version: jewel.version })).rejects.toThrow(/changed since/)
    const { rows: ev } = await db.query<{ actor: string; summary: string; data: { changes: unknown[]; version_from: number; version_to: number } }>(
      "select actor, summary, data from lp.events where kind = 'rules.updated' order by id desc limit 1",
    )
    expect(ev[0].actor).toBe('owner')
    expect(ev[0].summary).toMatch(/valid → valid, catch_all/)
    expect(ev[0].data.version_to).toBe(ev[0].data.version_from + 1)
    await runRecompute(db, { budgetMs: 30_000 })
    const counts = (await tierCounts(db)).get(jewel.id)!
    expect(counts).toMatchObject({ ready_generic: 1, ready_personalized: 1, parked: 1 })
  })

  it('a lead change marks its scores stale and the next pass refreshes them', async () => {
    await db.query("update lp.contacts set do_not_contact = true where email_norm = 'ruth@ruth.com'")
    const { rows } = await db.query<{ n: number }>('select count(*)::int as n from lp.lead_evaluations where company_id = $1 and stale', [co.ruth])
    expect(rows[0].n).toBeGreaterThan(0)
    await runRecompute(db, { budgetMs: 30_000 })
    const { rows: after } = await db.query<{ tier: string; stale: boolean }>('select tier, stale from lp.lead_evaluations e join lp.rule_sets s on s.id = e.rule_set_id where company_id = $1 and s.scope = $2', [co.ruth, 'pool'])
    expect(after).toEqual([{ tier: 'parked', stale: false }])
    await db.query("update lp.contacts set do_not_contact = false where email_norm = 'ruth@ruth.com'")
  })

  it('owner research exhausted releases the role inbox to its own role-inbox batch; the preview keeps it apart', async () => {
    await setOwnerResearchExhausted(db, 'tab', co.role, true, 'no owner email anywhere')
    const { rows: ev } = await db.query<{ actor: string; kind: string }>("select actor, kind from lp.events where kind like 'lead.owner_research%' order by id desc limit 1")
    expect(ev[0]).toEqual({ actor: 'tab', kind: 'lead.owner_research_exhausted' })
    const { rows: st } = await db.query<{ status: string }>("select status from lp.contacts where email_norm = 'info@role.com'")
    expect(st[0].status).toBe('role-based-hold') // never converted
    const standard = await buildAddPreview(db, { campaign_id: 'camp-x', company_ids: [co.ruth, co.role] }, async () => [])
    expect(standard.ready.map((l) => l.email)).toEqual(['ruth@ruth.com'])
    expect(standard.excluded.map((l) => l.excluded)).toEqual(['role_inbox_batch'])
    const roleBatch = await buildAddPreview(db, { campaign_id: 'camp-x', company_ids: [co.ruth, co.role], batch: 'role-inbox' }, async () => [])
    expect(roleBatch.ready.map((l) => l.email)).toEqual(['info@role.com'])
    expect(roleBatch.ready[0].tier).toBe('ready_generic')
    expect(toAddLead(roleBatch.ready[0], 'role-inbox').custom_variables).toMatchObject({ tab_batch: 'role-inbox' })
  })

  it('agents read rules and propose changes; a person applies them; PUT stays human-only', async () => {
    const pool = (await listRuleSets(db)).find((s) => s.segment === 'ai_builder')!
    const listed = (await runOp(db, 'hermes', 'list_rule_sets', {})) as { rule_sets: unknown[] }
    expect(listed.rule_sets.length).toBeGreaterThan(4)
    expect(routeToOp('POST', ['rules', String(pool.id), 'propose'])).toEqual({ op: 'propose_rule_change', args: { rule_set_id: pool.id } })
    const proposal = (await runOp(db, 'hermes', 'propose_rule_change', {
      rule_set_id: pool.id,
      name: pool.name,
      requirements: [...pool.requirements, { field: 'company.website_domain', op: 'present' }],
      fields: pool.fields,
      note: 'builders need a site',
    })) as { approval_id: number }
    expect((await getRuleSet(db, pool.id))!.version).toBe(pool.version) // nothing changed yet
    expect((await listProposals(db, pool.id)).map((p) => p.approval_id)).toEqual([proposal.approval_id])
    await applyProposal(db, 'owner', proposal.approval_id)
    const now = (await getRuleSet(db, pool.id))!
    expect(now.requirements).toHaveLength(2)
    expect((await listProposals(db, pool.id))).toEqual([])
    const { rows } = await db.query<{ summary: string }>("select summary from lp.events where kind = 'rules.updated' order by id desc limit 1")
    expect(rows[0].summary).toMatch(/applying hermes's proposal/)
    const res = await putRules(new Request(`http://x/api/rules/${now.id}`, { method: 'PUT', body: JSON.stringify({ name: 'Builders', requirements: now.requirements, fields: now.fields, base_version: now.version }) }), { params: Promise.resolve({ id: String(now.id) }) })
    expect(res.status).toBe(200)
    const bad = await putRules(new Request(`http://x/api/rules/${now.id}`, { method: 'PUT', body: JSON.stringify({ name: 'B', requirements: [{ field: 'nope', op: 'present' }], fields: [] }) }), { params: Promise.resolve({ id: String(now.id) }) })
    expect(bad.status).toBe(400)
    const all = await listRulesRoute()
    expect(((await all.json()) as { standing_rules: unknown[] }).standing_rules.length).toBe(7)
  })
})
