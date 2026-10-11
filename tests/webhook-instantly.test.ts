import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createTestDb } from './helpers/pglite-db'
import { ingestInstantlyEvent, nextStage } from '@/lib/webhooks/instantly'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
let contactId: number
let companyId: number

vi.mock('@/lib/db', () => ({ getDb: () => db }))
vi.mock('server-only', () => ({}))
const { revalidateTag } = vi.hoisted(() => ({ revalidateTag: vi.fn() }))
vi.mock('next/cache', () => ({ revalidateTag }))

beforeAll(async () => {
  db = await createTestDb()
  const co = await db.query<{ id: number }>("insert into lp.companies (name, website_domain, stage) values ('Gem Co', 'gemco.example', 'in_campaign') returning id")
  companyId = co.rows[0].id
  const c = await db.query<{ id: number }>("insert into lp.contacts (company_id, email, email_norm, status, verification_status) values ($1, 'owner@gemco.example', 'owner@gemco.example', 'in-Instantly', 'valid') returning id", [companyId])
  contactId = c.rows[0].id
})
afterAll(async () => {
  await db.close()
})

const base = { workspace: 'w', campaign_id: 'c-1', campaign_name: 'Fees angle' }

describe('Instantly webhook ingest', () => {
  it('records a send and moves the lead forward', async () => {
    const r = await ingestInstantlyEvent(db, { ...base, event_type: 'email_sent', lead_email: 'Owner@GemCo.example', timestamp: '2026-10-08T15:00:00Z', step: 1 })
    expect(r).toMatchObject({ stored: true, contact_id: contactId })
    const co = await db.query<{ stage: string }>('select stage from lp.companies where id = $1', [companyId])
    expect(co.rows[0].stage).toBe('contacted')
  })

  it('ignores a retried delivery of the same event', async () => {
    const e = { ...base, event_type: 'email_sent', lead_email: 'owner@gemco.example', timestamp: '2026-10-08T15:00:00Z', step: 1 }
    const r = await ingestInstantlyEvent(db, e)
    expect(r.duplicate).toBe(true)
    const n = await db.query<{ n: number }>("select count(*)::int as n from lp.campaign_touches where event_type = 'email_sent'")
    expect(n.rows[0].n).toBe(1)
  })

  it('a reply lands on the reply desk as a task and in the activity feed', async () => {
    const r = await ingestInstantlyEvent(db, { ...base, event_type: 'reply_received', lead_email: 'owner@gemco.example', timestamp: '2026-10-08T16:00:00Z', reply_text_snippet: 'Sure, call me Tuesday', unibox_url: 'https://app.instantly.ai/unibox/x' })
    expect(r.task_id).toBeTruthy()
    const t = await db.query<{ kind: string; title: string; project: string }>('select t.kind, t.title, p.name as project from lp.tasks t join lp.projects p on p.id = t.project_id where t.id = $1', [r.task_id])
    expect(t.rows[0]).toMatchObject({ kind: 'review_reply', project: 'Reply desk' })
    const c = await db.query<{ status: string }>('select status from lp.contacts where id = $1', [contactId])
    expect(c.rows[0].status).toBe('replied')
    const ev = await db.query<{ summary: string }>("select summary from lp.events where kind = 'webhook.reply_received'")
    expect(ev.rows[0].summary).toContain('Sure, call me Tuesday')
  })

  it('a bounce marks the address invalid; an unsubscribe marks do-not-contact', async () => {
    await ingestInstantlyEvent(db, { ...base, event_type: 'email_bounced', lead_email: 'owner@gemco.example', timestamp: '2026-10-08T17:00:00Z' })
    let c = await db.query<{ status: string; verification_status: string; do_not_contact: boolean }>('select status, verification_status, do_not_contact from lp.contacts where id = $1', [contactId])
    expect(c.rows[0]).toMatchObject({ status: 'bounced', verification_status: 'invalid' })
    await ingestInstantlyEvent(db, { ...base, event_type: 'lead_unsubscribed', lead_email: 'owner@gemco.example', timestamp: '2026-10-08T18:00:00Z' })
    c = await db.query('select status, verification_status, do_not_contact from lp.contacts where id = $1', [contactId])
    expect(c.rows[0]).toMatchObject({ status: 'do-not-contact', do_not_contact: true })
    const co = await db.query<{ stage: string }>('select stage from lp.companies where id = $1', [companyId])
    expect(co.rows[0].stage).toBe('do_not_contact')
  })

  it('stores events for unknown addresses without inventing a lead', async () => {
    const r = await ingestInstantlyEvent(db, { ...base, event_type: 'lead_out_of_office', lead_email: 'stranger@else.example', timestamp: '2026-10-08T19:00:00Z' })
    expect(r).toMatchObject({ stored: true, contact_id: null })
    const n = await db.query<{ n: number }>("select count(*)::int as n from lp.contacts where email_norm = 'stranger@else.example'")
    expect(n.rows[0].n).toBe(0)
  })

  it('stage moves forward only, except terminal outcomes', () => {
    expect(nextStage('replied', 'email_sent')).toBeNull()
    expect(nextStage('contacted', 'reply_received')).toBe('replied')
    expect(nextStage('lost', 'reply_received')).toBeNull()
    expect(nextStage('meeting', 'lead_unsubscribed')).toBe('do_not_contact')
  })
})

describe('POST /api/webhooks/instantly', () => {
  const SECRET = 'whsec-test-0123456789abcdef'
  async function call(headers: Record<string, string>, body: unknown) {
    const { POST } = await import('@/app/api/webhooks/instantly/route')
    return POST(new NextRequest('http://localhost/api/webhooks/instantly', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  }
  it('rejects a request without the shared secret, and when no secret is configured', async () => {
    vi.stubEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
    expect((await call({}, { event_type: 'email_sent' })).status).toBe(401)
    expect((await call({ authorization: 'Bearer wrong-secret-0000000000' }, { event_type: 'email_sent' })).status).toBe(401)
    vi.stubEnv('INSTANTLY_WEBHOOK_SECRET', '')
    expect((await call({ authorization: `Bearer ${SECRET}` }, { event_type: 'email_sent' })).status).toBe(401)
    vi.unstubAllEnvs()
  })
  it('stores an event with the right secret', async () => {
    vi.stubEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
    const res = await call({ authorization: `Bearer ${SECRET}` }, { ...base, event_type: 'lead_interested', lead_email: 'owner@gemco.example', timestamp: '2026-10-08T20:00:00Z' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.results[0].stored).toBe(true)
    const bad = await call({ 'x-webhook-secret': SECRET }, { nope: 1 })
    expect(bad.status).toBe(400)
    vi.unstubAllEnvs()
  })
  it('a newly stored reply clears the cached Instantly reads; a send or a duplicate does not', async () => {
    vi.stubEnv('INSTANTLY_WEBHOOK_SECRET', SECRET)
    const auth = { authorization: `Bearer ${SECRET}` }
    revalidateTag.mockClear()
    await call(auth, { ...base, event_type: 'email_sent', lead_email: 'owner@gemco.example', timestamp: '2026-10-09T09:00:00Z', step: 2 })
    expect(revalidateTag).not.toHaveBeenCalled()
    const reply = { ...base, event_type: 'reply_received', lead_email: 'owner@gemco.example', timestamp: '2026-10-09T10:00:00Z' }
    expect((await call(auth, reply)).status).toBe(200)
    expect(revalidateTag).toHaveBeenCalledWith('instantly')
    revalidateTag.mockClear()
    await call(auth, reply)
    expect(revalidateTag).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })
})
