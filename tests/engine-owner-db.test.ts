import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createTask } from '@/lib/ops/core'
import { runFindLeads, type TaskControl } from '@/engine/findLeads'
import { normalizeFindParams } from '@/engine/params'
import { ProxyPool, type HttpResponse } from '@/engine/io/http'
import type { SearchProvider } from '@/engine/io/search'
import type { SearchHit } from '@/engine/parse/search'
import { mapsBody, mkPlace } from './fixtures/engine-maps'

// Synthetic stores and people; no network.
type TestDb = Awaited<ReturnType<typeof createTestDb>>
const ok = (url: string, body: string, ct = 'text/html'): HttpResponse => ({ status: 200, url, headers: { 'content-type': ct }, body })
const status = (url: string, s: number): HttpResponse => ({ status: s, url, headers: {}, body: '' })

function fakeNet(calls: string[]) {
  return async (url: string): Promise<HttpResponse> => {
    calls.push(url)
    const u = new URL(url)
    if (u.hostname === 'www.google.com') {
      return ok(url, mapsBody([
        mkPlace({ name: 'Gem Co Jewelers', website: 'https://gemco.test/', phone: '(410) 555-0101', address: '1 Main St, Baltimore, MD 21201', categories: ['Jewelry store'], cid: 'c1' }),
        mkPlace({ name: 'Old Line Gold', website: 'https://oldline.test', phone: '(410) 555-0104', address: '3 Oak St, Baltimore, MD 21201', categories: ['Jewelry store'], cid: 'c4' }),
      ]), 'application/json')
    }
    if (u.hostname === 'gemco.test') {
      if (u.pathname === '/') return ok(url, '<html><a href="mailto:sarah@gemco.test">Email</a> <a href="/about">About us</a></html>')
      if (u.pathname === '/about') return ok(url, '<p>Gem Co was founded in 1987 by Sarah Klein.</p>')
      return status(url, 404)
    }
    if (u.hostname === 'www.facebook.com' && u.pathname === '/OldLineGold') {
      return ok(url, '<meta property="og:title" content="Old Line Gold"><div>Email oldlinegold.shop@gmail.com</div>')
    }
    return status(url, 404)
  }
}

function fakeSearch(queries: string[], withReviews = true): SearchProvider {
  const hit = (title: string, link: string, snippet: string): SearchHit => ({ title, link, snippet })
  return {
    name: withReviews ? 'serper' : 'searxng',
    async search(q) {
      queries.push(q)
      if (q.includes('site:yelp.com') && q.includes('Old Line Gold')) return [hit('Old Line Gold - Baltimore, MD - Yelp', 'https://www.yelp.com/biz/old-line-gold', 'Tom B. Business Owner replied to a review')]
      if (q.includes('site:facebook.com') && q.includes('Old Line Gold')) return [hit('Old Line Gold | Baltimore MD', 'https://www.facebook.com/OldLineGold', 'Jewelry store')]
      if (q.startsWith('"Tom" "Old Line Gold"')) return [hit('Tom Baker, owner of Old Line Gold', 'https://news.test/a', 'Tom Baker has run Old Line Gold since 1999.')]
      if (q === '"@oldline.test"') return [hit('Old Line Gold staff', 'https://dir.test/x', 'Contact Anna at anna@oldline.test for repairs')]
      return []
    },
    ...(withReviews
      ? {
          async reviews(place: { cid?: string | null }) {
            queries.push(`reviews:${place.cid}`)
            if (place.cid === 'c4') return { reviews: [{ snippet: 'Tom the owner fixed my chain.' }, { snippet: 'Great store', response: 'Thanks! Tom, owner' }], next: null }
            return { reviews: [], next: null }
          },
        }
      : {}),
  }
}

const deps = (o: Partial<Parameters<typeof runFindLeads>[3]>) => ({
  agent: 'tab',
  control: { heartbeat: async () => 'ok' as const } as TaskControl,
  search: null,
  proxies: new ProxyPool([]),
  mx: async () => ['mx.test'],
  heartbeatEveryMs: 0,
  politeness: { gapMs: 0, retry429Ms: 0, backoffBaseMs: 1 },
  ...o,
})

const ALL = ['discover', 'crawl', 'owner', 'reviews', 'yelp', 'firstlast', 'facebook', 'pattern', 'build']

describe('extra owner stages end to end (PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('reviews + yelp + last name + facebook + pattern guess land with evidence; guesses are held', async () => {
    const calls: string[] = []
    const queries: string[] = []
    const task = await createTask(db, 'owner', { kind: 'find_leads', title: 'extras', assigned_to: 'tab', payload: {} })
    const out = await runFindLeads(db, task.id, normalizeFindParams({ segment: 'jeweler', states: ['MD'], queries: ['jewelry store'], max_businesses: 5, stages: ALL }), deps({ fetch: fakeNet(calls), search: fakeSearch(queries) }))
    expect(out.status).toBe('done')
    expect(out.counters).toMatchObject({ kept: 2, built: 2, extras_checked: 2, extra_names: 1, facebook_emails: 1, pattern_guesses: 1 })
    // Gem Co's owner was already high from its own site: no reviews/yelp calls spent on it
    expect(queries).not.toContain('reviews:c1')

    const co = (await db.query<{ id: number; owner_name: string }>("select id, owner_name from lp.companies where website_domain = 'oldline.test'")).rows[0]
    expect(co.owner_name).toBe('Tom Baker')
    const enr = (await db.query<{ field: string; value: string; confidence: string; evidence_url: string }>('select field, value, confidence, evidence_url from lp.enrichment where company_id = $1', [co.id])).rows
    expect(enr.find((e) => e.field === 'owner_name')).toMatchObject({ value: 'Tom Baker', confidence: 'high', evidence_url: 'https://maps.google.com/?cid=c4' })
    expect(enr.find((e) => e.field === 'owner_last_name')).toMatchObject({ value: 'Baker', evidence_url: 'https://news.test/a' })
    expect(enr.find((e) => e.field === 'email_guess')).toMatchObject({ value: 'tom@oldline.test', confidence: 'medium', evidence_url: 'https://dir.test/x' })
    expect(enr.every((e) => e.field === 'mx' || !!e.evidence_url)).toBe(true)

    const contacts = (await db.query<{ email_norm: string; status: string; email_source: string; first_name: string | null }>('select email_norm, status, email_source, first_name from lp.contacts where company_id = $1 order by email_norm', [co.id])).rows
    expect(contacts.find((c) => c.email_norm === 'tom@oldline.test')).toMatchObject({ status: 'guessed-hold', email_source: 'guessed', first_name: 'Tom' })
    expect(contacts.find((c) => c.email_norm === 'oldlinegold.shop@gmail.com')).toMatchObject({ status: 'new', email_source: 'facebook' })
    expect(contacts.find((c) => c.email_norm === 'anna@oldline.test')?.status).toBe('new')
    // Facebook was fetched only for the store with no email on its site
    expect(calls.filter((u) => u.includes('facebook.com'))).toEqual(['https://www.facebook.com/OldLineGold'])
    expect((await db.query("select 1 from lp.events where kind = 'engine.owner_extras'")).rows.length).toBe(1)
  }, 30_000)

  it('SearXNG has no reviews endpoint; no provider skips search stages but pattern still runs', async () => {
    const db2 = await createTestDb()
    try {
      const t1 = await createTask(db2, 'owner', { kind: 'find_leads', title: 'x', assigned_to: 'tab', payload: {} })
      const out1 = await runFindLeads(db2, t1.id, normalizeFindParams({ segment: 'jeweler', states: ['MD'], queries: ['jewelry store'], max_businesses: 5, stages: ALL }), deps({ fetch: fakeNet([]), search: fakeSearch([], false) }))
      expect(out1.status).toBe('done')
      const notes1 = (await db2.query<{ notes: unknown }>('select notes from lp.engine_runs where task_id = $1', [t1.id])).rows[0]
      expect(JSON.stringify(notes1)).toMatch(/Skipped Maps reviews: the searxng search provider has no reviews endpoint/)

    } finally {
      await db2.close()
    }
    const db3 = await createTestDb() // fresh: the first run already put both stores in Leads
    try {
      const t2 = await createTask(db3, 'owner', { kind: 'find_leads', title: 'y', assigned_to: 'tab', payload: {} })
      const out2 = await runFindLeads(db3, t2.id, normalizeFindParams({ segment: 'jeweler', states: ['MD'], queries: ['jewelry store'], max_businesses: 5, stages: ALL }), deps({ fetch: fakeNet([]), search: null }))
      expect(out2.status).toBe('done')
      const notes2 = (await db3.query<{ notes: unknown }>('select notes from lp.engine_runs where task_id = $1', [t2.id])).rows[0]
      expect(JSON.stringify(notes2)).toMatch(/Skipped reviews, yelp, firstlast, facebook: no search provider/)
      expect(out2.counters).toMatchObject({ kept: 2, built: 2, extras_checked: 2, pattern_guesses: 0 })
    } finally {
      await db3.close()
    }
  }, 30_000)
})
