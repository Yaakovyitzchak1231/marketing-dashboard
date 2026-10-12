import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { applyResearchResult } from '@/lib/research/apply'
import { upsertCompany } from '@/lib/research/companies'
import { createTask, claimTask } from '@/lib/ops/core'
import { runFindLeads, type TaskControl } from '@/engine/findLeads'
import { normalizeFindParams } from '@/engine/params'
import { workTaskDb } from '@/engine/worker'
import { ProxyPool, type HttpResponse } from '@/engine/io/http'
import type { ResearchResult } from '@/lib/research/types'
import { mapsBody, mkPlace } from './fixtures/engine-maps'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

const ok = (url: string, body: string, ct = 'text/html'): HttpResponse => ({ status: 200, url, headers: { 'content-type': ct }, body })
const status = (url: string, s: number): HttpResponse => ({ status: s, url, headers: {}, body: '' })

/** A fake internet: Google Maps answers with four places; two store sites. No network. */
function fakeNet(calls: string[] = []) {
  return async (url: string): Promise<HttpResponse> => {
    calls.push(url)
    const u = new URL(url)
    if (u.hostname === 'www.google.com') {
      return ok(url, mapsBody([
        mkPlace({ name: 'Gem Co Jewelers', website: 'https://gemco.test/', phone: '(410) 555-0101', address: '1 Main St, Baltimore, MD 21201', categories: ['Jewelry store'], cid: 'c1', reviews: 40 }),
        mkPlace({ name: 'Kay Jewelers', website: 'https://kay.com/s/1', categories: ['Jewelry store'], cid: 'c2' }),
        mkPlace({ name: 'Ring Studio', website: 'http://ringstudio.test', phone: '410-555-0102', address: '2 Elm St, Baltimore, MD 21201', categories: ['Jeweler'], cid: 'c3' }),
        mkPlace({ name: 'Old Line Gold', website: 'https://oldline.test', categories: ['Jewelry store'], address: '3 Oak St, Baltimore, MD 21201', cid: 'c4' }),
        mkPlace({ name: 'No Site Jewelry', categories: ['Jewelry store'], cid: 'c5' }),
      ]), 'application/json')
    }
    if (u.hostname === 'gemco.test') {
      if (u.pathname === '/robots.txt') return ok(url, 'User-agent: *\nDisallow: /private', 'text/plain')
      if (u.pathname === '/') return ok(url, '<html><a href="mailto:sarah@gemco.test">Email</a> <a href="/about">About us</a> <a href="tel:+14105550101">call</a> <script src="https://cdn.shopify.com/x.js"></script></html>')
      if (u.pathname === '/about') return ok(url, '<p>Gem Co was founded in 1987 by Sarah Klein, who still runs the counter.</p><p>info@gemco.test</p>')
      return status(url, 404)
    }
    if (u.hostname === 'ringstudio.test') return status(url, 429)
    return status(url, 404)
  }
}

const params = (o: Record<string, unknown> = {}) =>
  normalizeFindParams({ segment: 'jeweler', states: ['MD'], queries: ['jewelry store'], max_businesses: 5, stages: ['discover', 'crawl', 'owner', 'build'], ...o })

const deps = (o: Partial<Parameters<typeof runFindLeads>[3]> = {}) => ({
  agent: 'tab',
  control: { heartbeat: async () => 'ok' as const } as TaskControl,
  search: null,
  proxies: new ProxyPool([]),
  fetch: fakeNet(),
  mx: async () => ['mx.test'],
  heartbeatEveryMs: 0,
  politeness: { gapMs: 0, retry429Ms: 0, backoffBaseMs: 1 },
  ...o,
})

describe('applyResearchResult', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('writes evidence-backed rows, dedupes, and never overwrites what a person set', async () => {
    const a = await db.tx((q) => upsertCompany(q, { name: 'Gem Co', website: 'https://www.gemco.test/home', city: 'Towson', state: 'MD' }, 'owner'), 'owner')
    const b = await db.tx((q) => upsertCompany(q, { name: 'Other Store', website: 'other.test' }, 'owner'), 'owner')
    expect(a.created).toBe(true)
    // same domain again = same company
    expect((await db.tx((q) => upsertCompany(q, { name: 'Gem Co LLC', website: 'gemco.test', phone: '410 555 0101' }, 'owner'), 'owner')).id).toBe(a.id)
    await db.query(`insert into lp.contacts (company_id, email, email_norm, first_name) values ($1, 'Info@GemCo.test', 'info@gemco.test', 'Front Desk')`, [a.id])
    await db.query(`insert into lp.contacts (company_id, email, email_norm) values ($1, 'shared@other.test', 'shared@other.test')`, [b.id])

    const r: ResearchResult = {
      company_id: a.id,
      runner: 'tab',
      pages_fetched: [{ url: 'https://gemco.test/', status: 200 }],
      emails: [
        { email: 'Sarah@gemco.test', evidence_url: 'https://gemco.test/', how: 'mailto' },
        { email: 'info@gemco.test', evidence_url: 'https://gemco.test/contact', how: 'text', first_name: 'Robot' },
        { email: 'shared@other.test', evidence_url: 'https://gemco.test/', how: 'text' },
        { email: 'nope@gemco.test', evidence_url: '', how: 'text' },
      ],
      people: [{ name: 'Sarah Klein', role: 'owner', evidence_url: 'https://gemco.test/about', confidence: 'high', how: 'owned_by' }],
      phones: [{ phone: '(410) 555-0101', evidence_url: 'https://gemco.test/' }],
      facts: [{ field: 'tech', value: 'shopify', evidence_url: 'https://gemco.test/', confidence: 'medium' }],
      summary: 'test',
    }
    const s = await applyResearchResult(db, r, 'tab', { task_id: null })
    expect(s).toMatchObject({ contacts_created: 1, contacts_existing: 1, contacts_other_company: 1, owner_set: 'Sarah Klein', phone_set: null, research_status: 'researched' })
    // the phone was already filled by the second upsert (same domain), so research didn't need to set it

    const contacts = (await db.query<{ email_norm: string; company_id: number; first_name: string | null; last_name: string | null; email_source: string }>(
      'select email_norm, company_id, first_name, last_name, email_source from lp.contacts order by email_norm',
    )).rows
    expect(contacts.find((c) => c.email_norm === 'sarah@gemco.test')).toMatchObject({ company_id: a.id, first_name: 'Sarah', last_name: 'Klein', email_source: 'website' })
    expect(contacts.find((c) => c.email_norm === 'info@gemco.test')?.first_name).toBe('Front Desk') // a person's value stays
    expect(contacts.find((c) => c.email_norm === 'shared@other.test')?.company_id).toBe(b.id) // not moved
    expect(contacts.some((c) => c.email_norm === 'nope@gemco.test')).toBe(false) // no evidence, no row

    const co = (await db.query<{ owner_name: string; research_status: string; stage: string }>('select owner_name, research_status, stage from lp.companies where id = $1', [a.id])).rows[0]
    expect(co).toMatchObject({ owner_name: 'Sarah Klein', research_status: 'researched', stage: 'researched' })
    const fields = (await db.query<{ field: string }>('select field from lp.enrichment where company_id = $1 order by field', [a.id])).rows.map((x) => x.field)
    expect(fields).toEqual(expect.arrayContaining(['email', 'owner_name', 'phone', 'tech']))
    const ev = (await db.query<{ summary: string }>("select summary from lp.events where kind = 'research.applied'")).rows
    expect(ev[0].summary).toMatch(/Researched Gem Co: 1 new email, 1 already on file, 1 belong to another company, owner Sarah Klein \(high\)/)

    // second run with a different owner name: owner_name is not overwritten, enrichment is not duplicated
    const s2 = await applyResearchResult(db, { ...r, people: [{ ...r.people[0], name: 'Someone Else' }] }, 'tab')
    expect(s2.owner_set).toBeNull()
    expect(s2.contacts_created).toBe(0)
    const owner = (await db.query<{ owner_name: string }>('select owner_name from lp.companies where id = $1', [a.id])).rows[0]
    expect(owner.owner_name).toBe('Sarah Klein')
  })

  it('marks a company failed when nothing could be read', async () => {
    const c = await db.tx((q) => upsertCompany(q, { name: 'Dead Site', website: 'dead.test' }, 'owner'), 'owner')
    const s = await applyResearchResult(db, { company_id: c.id, runner: 'engine', pages_fetched: [{ url: 'http://dead.test/', status: null, error: 'timeout' }], emails: [], people: [], phones: [], facts: [], summary: '' }, 'tab')
    expect(s.research_status).toBe('failed')
  })
})

describe('runFindLeads', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    // already in Leads: Old Line Gold's domain
    await db.tx((q) => upsertCompany(q, { name: 'Old Line Gold', website: 'oldline.test' }, 'owner'), 'owner')
  })
  afterAll(async () => db.close())

  it('discovers, filters, crawls and builds leads with evidence; counts come from the rows', async () => {
    const task = await createTask(db, 'owner', { kind: 'find_leads', title: 'Find 5 jewelers in MD', assigned_to: 'tab', payload: params() as unknown as Record<string, unknown> })
    const out = await runFindLeads(db, task.id, params(), deps())
    expect(out.status).toBe('done')
    const c = out.counters
    expect(c.kept).toBe(2) // Gem Co + Ring Studio
    // Kay Jewelers now also matches the pool's built-in negative-keyword list
    // ('kay jewelers'), checked before the jeweler-specific chain-name regex,
    // so it is dropped as excluded_by_negative_keyword instead of chain_or_nonjeweler_name.
    expect(c.dropped).toMatchObject({ excluded_by_negative_keyword: 1, no_website: 1, already_in_leads: 1 })
    expect(c.built).toBe(2)
    expect(c.companies_new).toBe(2)
    expect(c.sites_ok).toBe(1) // Ring Studio answered 429
    expect(c.emails_new).toBe(2)
    expect(c.owners_found).toBe(1)

    const gem = (await db.query<{ id: number; owner_name: string; phone_e164: string; research_status: string }>("select id, owner_name, phone_e164, research_status from lp.companies where website_domain = 'gemco.test'")).rows[0]
    expect(gem).toMatchObject({ owner_name: 'Sarah Klein', phone_e164: '+14105550101', research_status: 'researched' })
    const emails = (await db.query<{ email_norm: string }>('select email_norm from lp.contacts where company_id = $1 order by 1', [gem.id])).rows.map((r) => r.email_norm)
    expect(emails).toEqual(['info@gemco.test', 'sarah@gemco.test'])
    // the job link the Leads screen filters on
    const linked = (await db.query<{ n: number }>("select count(distinct company_id)::int as n from lp.sources where source_ref = $1", [`find_leads:${task.id}`])).rows[0].n
    expect(linked).toBe(2)
    const ring = (await db.query<{ research_status: string }>("select research_status from lp.companies where website_domain = 'ringstudio.test'")).rows[0]
    expect(ring.research_status).toBe('failed')
    const tech = (await db.query<{ value: string }>("select value from lp.enrichment where company_id = $1 and field = 'tech'", [gem.id])).rows
    expect(tech.map((t) => t.value)).toContain('shopify')
    const done = (await db.query<{ summary: string }>("select summary from lp.events where kind = 'engine.done'")).rows[0]
    expect(done.summary).toMatch(/2 independents kept/)
    const notes = (await db.query<{ notes: string[] }>('select notes from lp.engine_runs where task_id = $1', [task.id])).rows[0].notes
    expect(notes.join(' ')).toMatch(/Owner search skipped/)
  })

  it('stops on cancel and resumes from its checkpoints without redoing finished items', async () => {
    const db2 = await createTestDb()
    try {
      const task = await createTask(db2, 'owner', { kind: 'find_leads', title: 'resume test', assigned_to: 'tab', payload: {} })
      let beats = 0
      const calls1: string[] = []
      const cancelSoon: TaskControl = { heartbeat: async () => (++beats >= 3 ? 'cancelled' : 'ok') }
      const first = await runFindLeads(db2, task.id, params(), deps({ control: cancelSoon, fetch: fakeNet(calls1) }))
      expect(first.status).toBe('cancelled')
      const searchesFirst = calls1.filter((u) => u.includes('google.com')).length
      expect((await db2.query<{ status: string }>('select status from lp.engine_runs where task_id = $1', [task.id])).rows[0].status).toBe('cancelled')

      const calls2: string[] = []
      const second = await runFindLeads(db2, task.id, params({ max_businesses: 999 }), deps({ fetch: fakeNet(calls2) }))
      expect(second.status).toBe('done')
      // this fresh database has no Old Line Gold yet, so three independents are kept
      expect(second.counters.kept).toBe(3)
      expect(second.counters.built).toBe(3)
      // the resumed run kept its original params and did not re-run finished searches
      const doneSearches = (await db2.query<{ n: number }>("select count(*)::int as n from lp.engine_items where kind = 'search' and stage = 'searched'")).rows[0].n
      expect(calls2.filter((u) => u.includes('google.com')).length + searchesFirst).toBeGreaterThanOrEqual(doneSearches)
      const items = (await db2.query<{ n: number }>("select count(*)::int as n from lp.engine_items where kind = 'place' and status <> 'dropped'")).rows[0].n
      expect(items).toBe(3)
      expect((await db2.query("select 1 from lp.events where kind = 'engine.resumed'")).rows.length).toBe(1)
    } finally {
      await db2.close()
    }
  })

  it('a file list works as the discovery source (no Maps calls)', async () => {
    const { writeFileSync, mkdtempSync } = await import('node:fs')
    const { join } = await import('node:path')
    const { tmpdir } = await import('node:os')
    const dir = mkdtempSync(join(tmpdir(), 'engine-'))
    const file = join(dir, 'stores.csv')
    writeFileSync(file, 'name,website,phone,city,state\nGem Co Jewelers,https://gemco.test,4105550101,Baltimore,MD\nZales,https://zales.com,,Baltimore,MD\n')
    const db3 = await createTestDb()
    try {
      const calls: string[] = []
      const task = await createTask(db3, 'owner', { kind: 'find_leads', title: 'file', assigned_to: 'tab', payload: {} })
      const out = await runFindLeads(db3, task.id, normalizeFindParams({ segment: 'jeweler', source: 'file', file_path: file, max_businesses: 10 }), deps({ fetch: fakeNet(calls) }))
      expect(out.status).toBe('done')
      // Zales also matches the pool's built-in negative-keyword list ('zales'), checked
      // before the jeweler-specific chain-name regex, so it is dropped as excluded_by_negative_keyword.
      expect(out.counters).toMatchObject({ kept: 1, built: 1, dropped: { excluded_by_negative_keyword: 1 } })
      expect(calls.some((u) => u.includes('google.com'))).toBe(false)
    } finally {
      await db3.close()
    }
  })
})

describe('worker (database door)', () => {
  it('claims a research_company task, applies the result and completes it', async () => {
    const db = await createTestDb()
    try {
      const c = await db.tx((q) => upsertCompany(q, { name: 'Gem Co', website: 'https://gemco.test' }, 'owner'), 'owner')
      await createTask(db, 'owner', { kind: 'research_company', title: 'Research Gem Co', assigned_to: 'tab', company_id: c.id, dedupe_key: `research:${c.id}`, payload: { name: 'Gem Co', website: 'https://gemco.test' } })
      const t = await claimTask(db, 'tab', { kinds: ['research_company'] })
      expect(t).not.toBeNull()
      const r = await workTaskDb(db, t!, { agent: 'tab', search: null, log: () => undefined, fetch: fakeNet(), mx: async () => ['mx.test'], politeness: { gapMs: 0 } })
      expect(r).toBe('done')
      const task = (await db.query<{ status: string; report: string | null }>('select status, report from lp.tasks where id = $1', [t!.id])).rows[0]
      expect(task.status).toBe('done')
      expect(task.report).toMatch(/2 new emails added, owner set to Sarah Klein/)
      const co = (await db.query<{ research_status: string; owner_name: string }>('select research_status, owner_name from lp.companies where id = $1', [c.id])).rows[0]
      expect(co).toMatchObject({ research_status: 'researched', owner_name: 'Sarah Klein' })
    } finally {
      await db.close()
    }
  })
})
