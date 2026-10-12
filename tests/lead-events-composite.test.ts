/**
 * Sheet row 1.4 — the two missing pieces of the lead event stream:
 * (a) composite event rules (positive_reply derives from reply_received +
 *     lead_interested/meeting_booked), evaluated at every ingress point;
 * (b) page_visited and form_submitted emitters + the site-events webhook.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
// The site-events route reads its DB through getDb(); point it at the pglite
// instance for the route tests below. The closure is read at request time.
let routeDb: unknown = null
vi.mock('@/lib/db', () => ({ getDb: () => routeDb }))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { emitLeadEvent, EventError } from '@/lib/events/emit'
import { evaluateCompositeRules, COMPOSITE_RULES } from '@/lib/events/composite'
import { emitPageVisited, emitFormSubmitted } from '@/lib/events/web'
import { ingestInstantlyEvent } from '@/lib/webhooks/instantly'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function typesFor(db: TestDb, contactId: number): Promise<string[]> {
  const { rows } = await db.query<{ type: string }>(
    'select type from lp.lead_events where contact_id = $1 order by id',
    [contactId],
  )
  return rows.map((r) => r.type)
}

async function positiveReplies(db: TestDb, contactId: number) {
  const { rows } = await db.query<{ dedupe_key: string | null; props: Record<string, unknown>; source: string }>(
    "select dedupe_key, props, source from lp.lead_events where contact_id = $1 and type = 'positive_reply'",
    [contactId],
  )
  return rows
}

describe('composite rules', () => {
  let db: TestDb
  let co: number
  let contact: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example' })
    contact = await addContact(db, co, 'owner@gemco.example', 'valid')
  })
  afterAll(async () => db.close())

  it('registers positive_reply as a rule', () => {
    expect(COMPOSITE_RULES.map((r) => r.type)).toContain('positive_reply')
  })

  it('a lone reply does not fire positive_reply; the interest mark completes it', async () => {
    const reply = await emitLeadEvent(db, { type: 'reply_received', contact_id: contact, source: 'test' })
    expect(await evaluateCompositeRules(db, { id: reply.id!, type: 'reply_received', company_id: co, contact_id: contact })).toEqual([])
    expect(await positiveReplies(db, contact)).toHaveLength(0)

    const interested = await emitLeadEvent(db, { type: 'lead_interested', contact_id: contact, source: 'test' })
    const evaled = await evaluateCompositeRules(db, { id: interested.id!, type: 'lead_interested', company_id: co, contact_id: contact })
    expect(evaled).toMatchObject([{ rule: 'positive_reply', fired: true, inserted: true }])
    const prs = await positiveReplies(db, contact)
    expect(prs).toHaveLength(1)
    expect(prs[0]).toMatchObject({
      source: 'composite_rule',
      dedupe_key: `composite:positive_reply:contact_id:${contact}`,
    })
    expect(prs[0].props).toMatchObject({ rule: 'positive_reply', triggered_by_type: 'lead_interested', triggered_by_event_id: interested.id })
  })

  it('fires at most once per lead', async () => {
    const again = await emitLeadEvent(db, { type: 'lead_interested', contact_id: contact, source: 'test' })
    const evaled = await evaluateCompositeRules(db, { id: again.id!, type: 'lead_interested', company_id: co, contact_id: contact })
    expect(evaled).toMatchObject([{ rule: 'positive_reply', fired: true, inserted: false }])
    expect(await positiveReplies(db, contact)).toHaveLength(1)
  })

  it('fires when the reply arrives after the interest mark (either order)', async () => {
    const co2 = await addCompany(db, { name: 'Ring Bros', domain: 'ringbros.example' })
    const c2 = await addContact(db, co2, 'owner@ringbros.example', 'valid')
    const interested = await emitLeadEvent(db, { type: 'lead_interested', contact_id: c2, source: 'test' })
    expect(await evaluateCompositeRules(db, { id: interested.id!, type: 'lead_interested', company_id: co2, contact_id: c2 })).toEqual([])
    const reply = await emitLeadEvent(db, { type: 'reply_received', contact_id: c2, source: 'test' })
    const evaled = await evaluateCompositeRules(db, { id: reply.id!, type: 'reply_received', company_id: co2, contact_id: c2 })
    expect(evaled).toMatchObject([{ rule: 'positive_reply', fired: true, inserted: true }])
    // ...and the first lead's composite is untouched.
    expect(await positiveReplies(db, contact)).toHaveLength(1)
  })

  it('meeting_booked also completes a positive reply', async () => {
    const co3 = await addCompany(db, { name: 'Band Co', domain: 'bandco.example' })
    const c3 = await addContact(db, co3, 'owner@bandco.example', 'valid')
    await emitLeadEvent(db, { type: 'reply_received', contact_id: c3, source: 'test' })
    const meeting = await emitLeadEvent(db, { type: 'meeting_booked', contact_id: c3, source: 'test' })
    const evaled = await evaluateCompositeRules(db, { id: meeting.id!, type: 'meeting_booked', company_id: co3, contact_id: c3 })
    expect(evaled).toMatchObject([{ rule: 'positive_reply', fired: true, inserted: true }])
  })

  it('an event with no lead identity evaluates nothing', async () => {
    const r = await emitLeadEvent(db, { type: 'lead_interested', email: 'ghost@example.com', source: 'test' })
    // ghost@example.com is not a contact: no company/contact resolution.
    expect(r.contact_id).toBeNull()
    expect(await evaluateCompositeRules(db, { id: r.id!, type: 'lead_interested', company_id: null, contact_id: null })).toEqual([])
  })
})

describe('Instantly webhook: composite evaluation in the same transaction', () => {
  let db: TestDb
  let co: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example', stage: 'in_campaign' })
    await addContact(db, co, 'owner@gemco.example', 'valid', { status: 'in-Instantly' })
  })
  afterAll(async () => db.close())

  const base = { workspace: 'w', campaign_id: 'instantly-c-1', campaign_name: 'Fees angle' }

  it('reply_received then lead_interested derives positive_reply', async () => {
    await ingestInstantlyEvent(db, { ...base, event_type: 'reply_received', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T12:00:00Z' })
    await ingestInstantlyEvent(db, { ...base, event_type: 'lead_interested', lead_email: 'owner@gemco.example', timestamp: '2026-10-11T12:05:00Z' })
    const { rows } = await db.query<{ type: string; source: string }>(
      'select type, source from lp.lead_events where company_id = $1 order by id',
      [co],
    )
    const types = rows.map((r) => r.type)
    expect(types).toContain('reply_received')
    expect(types).toContain('lead_interested')
    expect(types).toContain('positive_reply')
    expect(rows.find((r) => r.type === 'positive_reply')?.source).toBe('composite_rule')
  })
})

describe('site emitters: page_visited / form_submitted', () => {
  let db: TestDb
  let co: number
  let contact: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example' })
    contact = await addContact(db, co, 'owner@gemco.example', 'valid')
  })
  afterAll(async () => db.close())

  it('page_visited resolves the lead by email and stores page props', async () => {
    const r = await emitPageVisited(db, {
      email: 'owner@gemco.example',
      url: 'https://tapdash.co/pricing',
      page_title: 'Pricing',
      referrer: 'https://www.google.com/',
    })
    expect(r).toMatchObject({ inserted: true, type: 'page_visited', contact_id: contact, company_id: co })
    const { rows } = await db.query<{ source: string; props: Record<string, unknown> }>(
      "select source, props from lp.lead_events where type = 'page_visited' order by id desc limit 1",
    )
    expect(rows[0].source).toBe('site')
    expect(rows[0].props).toMatchObject({ url: 'https://tapdash.co/pricing', page_title: 'Pricing', referrer: 'https://www.google.com/' })
  })

  it('a bad url is dropped, not fatal', async () => {
    const r = await emitPageVisited(db, { contact_id: contact, url: 'not a url' })
    expect(r.inserted).toBe(true)
    const { rows } = await db.query<{ props: Record<string, unknown> }>(
      "select props from lp.lead_events where type = 'page_visited' order by id desc limit 1",
    )
    expect(rows[0].props).not.toHaveProperty('url')
  })

  it('form_submitted needs a form id or name, and never stores field values', async () => {
    await expect(emitFormSubmitted(db, { contact_id: contact, url: 'https://tapdash.co/' })).rejects.toThrow(EventError)
    const r = await emitFormSubmitted(db, { contact_id: contact, form_id: 'demo-request', url: 'https://tapdash.co/demo' })
    expect(r).toMatchObject({ inserted: true, type: 'form_submitted' })
    const { rows } = await db.query<{ props: Record<string, unknown> }>(
      "select props from lp.lead_events where type = 'form_submitted' order by id desc limit 1",
    )
    expect(rows[0].props).toMatchObject({ form_id: 'demo-request', url: 'https://tapdash.co/demo' })
  })

  it('prefixes a client-supplied dedupe_key server-side', async () => {
    const r = await emitPageVisited(db, { contact_id: contact, dedupe_key: 'visitor-1', url: 'https://tapdash.co/' })
    expect(r.inserted).toBe(true)
    const { rows } = await db.query<{ dedupe_key: string | null }>(
      "select dedupe_key from lp.lead_events where type = 'page_visited' order by id desc limit 1",
    )
    expect(rows[0].dedupe_key).toBe('site:page_visited:visitor-1')
  })

  it('the same client key on a different type does not collide', async () => {
    const a = await emitPageVisited(db, { contact_id: contact, dedupe_key: 'same-key', url: 'https://tapdash.co/' })
    const b = await emitFormSubmitted(db, { contact_id: contact, dedupe_key: 'same-key', form_id: 'demo', url: 'https://tapdash.co/' })
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(true)
    const { rows } = await db.query<{ dedupe_key: string }>(
      "select dedupe_key from lp.lead_events where dedupe_key like '%:same-key' order by id",
    )
    expect(rows.map((r) => r.dedupe_key).sort()).toEqual(['site:form_submitted:same-key', 'site:page_visited:same-key'])
  })

  it('query strings and fragments are stripped from stored url/referrer (PII)', async () => {
    const r = await emitPageVisited(db, {
      contact_id: contact,
      url: 'https://tapdash.co/pricing?email=owner@gemco.example&utm_source=x#frag',
      referrer: 'https://www.google.com/?q=tapdash',
    })
    expect(r.inserted).toBe(true)
    const { rows } = await db.query<{ props: Record<string, unknown> }>(
      "select props from lp.lead_events where type = 'page_visited' order by id desc limit 1",
    )
    expect(rows[0].props).toMatchObject({ url: 'https://tapdash.co/pricing', referrer: 'https://www.google.com/' })
    expect(JSON.stringify(rows[0].props)).not.toContain('email=')
  })
})

describe('POST /api/webhooks/site-events', () => {
  let db: TestDb
  let contact: number
  beforeAll(async () => {
    db = await createTestDb()
    routeDb = db
    const co = await addCompany(db, { name: 'Gem Co', domain: 'gemco.example' })
    contact = await addContact(db, co, 'owner@gemco.example', 'valid')
    process.env.SITE_EVENTS_SECRET = 'test-secret-0123456789'
  })
  afterAll(async () => {
    delete process.env.SITE_EVENTS_SECRET
    routeDb = null
    await db.close()
  })

  it('rejects a missing secret with 401 before touching the database', async () => {
    const { POST } = await import('@/app/api/webhooks/site-events/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest('http://localhost/api/webhooks/site-events', {
      method: 'POST',
      body: JSON.stringify({ type: 'page_visited', email: 'owner@gemco.example' }),
    }))
    expect(res.status).toBe(401)
  })

  it('records a page visit with the secret', async () => {
    const { POST } = await import('@/app/api/webhooks/site-events/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest('http://localhost/api/webhooks/site-events', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-0123456789' },
      body: JSON.stringify({ type: 'page_visited', email: 'owner@gemco.example', url: 'https://tapdash.co/' }),
    }))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ ok: true, inserted: true, type: 'page_visited' })
    expect(await typesFor(db, contact)).toContain('page_visited')
  })

  it('rejects a wrong secret with 401', async () => {
    const { POST } = await import('@/app/api/webhooks/site-events/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest('http://localhost/api/webhooks/site-events', {
      method: 'POST',
      headers: { authorization: 'Bearer definitely-not-the-secret' },
      body: JSON.stringify({ type: 'page_visited', email: 'owner@gemco.example' }),
    }))
    expect(res.status).toBe(401)
  })

  it('prefixes the client dedupe_key and strips query strings at the route', async () => {
    const prev = process.env.SITE_EVENTS_SECRET
    process.env.SITE_EVENTS_SECRET = 'route-test-secret'
    try {
      const { POST } = await import('@/app/api/webhooks/site-events/route')
      const { NextRequest } = await import('next/server')
      const res = await POST(new NextRequest('http://localhost/api/webhooks/site-events', {
        method: 'POST',
        headers: { authorization: 'Bearer route-test-secret' },
        body: JSON.stringify({
          type: 'page_visited',
          email: 'owner@gemco.example',
          url: 'https://tapdash.co/a?email=owner@gemco.example',
          dedupe_key: 'route-key',
        }),
      }))
      expect(res.status).toBe(200)
      const { rows } = await db.query<{ dedupe_key: string | null; props: Record<string, unknown> }>(
        "select dedupe_key, props from lp.lead_events where type = 'page_visited' order by id desc limit 1",
      )
      expect(rows[0].dedupe_key).toBe('site:page_visited:route-key')
      expect(rows[0].props).toMatchObject({ url: 'https://tapdash.co/a' })
    } finally {
      process.env.SITE_EVENTS_SECRET = prev
    }
  })

  it('rejects an unknown type with 400', async () => {
    const { POST } = await import('@/app/api/webhooks/site-events/route')
    const { NextRequest } = await import('next/server')
    const res = await POST(new NextRequest('http://localhost/api/webhooks/site-events', {
      method: 'POST',
      headers: { authorization: 'Bearer test-secret-0123456789' },
      body: JSON.stringify({ type: 'email_sent', email: 'owner@gemco.example' }),
    }))
    expect(res.status).toBe(400)
  })
})
