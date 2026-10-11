import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { InstantlyClient } from '@/lib/instantly/client'
import { reconcileInstantly, isAutoReply } from '@/lib/instantly/reconcile'
import { createTestDb } from './helpers/pglite-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const CAMP = '11111111-1111-4111-8111-111111111111'

async function seedContact(email: string): Promise<number> {
  const co = await db.query<{ id: number }>("insert into lp.companies (name, website_domain, stage) values ($1, $1, 'in_campaign') returning id", [email.split('@')[1]])
  const c = await db.query<{ id: number }>(
    "insert into lp.contacts (company_id, email, email_norm, status, verification_status) values ($1, $2, $2, 'in-Instantly', 'valid') returning id",
    [co.rows[0].id, email],
  )
  return c.rows[0].id
}

async function webhookEvent(contactId: number, email: string, type: string, at: string, key: string, props: Record<string, unknown> = {}) {
  await db.query(
    `insert into lp.lead_events (occurred_at, type, contact_id, email_norm, instantly_campaign_id, source, dedupe_key, props)
     values ($1, $2, $3, $4, $5, 'instantly_webhook', $6, $7)`,
    [at, type, contactId, email, CAMP, key, JSON.stringify(props)],
  )
}

function fakeFetch(leads: unknown[], emails: unknown[]): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v2/, '')
    const body = path === '/leads/list' ? { items: leads, next_starting_after: null } : path === '/emails' ? { items: emails, next_starting_after: null } : { message: 'no route' }
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}
const client = (f: typeof fetch) => new InstantlyClient({ apiKey: 'k', fetchImpl: f, backoffMs: 0, memoTtlMs: 0, sleep: async () => {} })

// Viktor's #75 review: reconcile duplicated replies/statuses the webhook already saved, and
// recorded autoresponders as human replies.
describe('review fix #75: reconcile vs webhook duplicates, auto-replies', () => {
  let ann: number
  beforeAll(async () => {
    db = await createTestDb()
    ann = await seedContact('ann@shop-a.example')
    await seedContact('ooo@shop-b.example')
    await seedContact('new@shop-c.example')
    const recent = new Date(Date.now() - 2 * 86400_000).toISOString()
    // The webhook already saved Ann's reply and her "interested" status.
    await webhookEvent(ann, 'ann@shop-a.example', 'reply_received', recent, 'touch:1')
    await webhookEvent(ann, 'ann@shop-a.example', 'lead_interested', recent, 'touch:2')
    const ooo = (await db.query<{ id: number }>("select id from lp.contacts where email_norm = 'ooo@shop-b.example'")).rows[0].id
    const neu = (await db.query<{ id: number }>("select id from lp.contacts where email_norm = 'new@shop-c.example'")).rows[0].id
    await webhookEvent(ooo, 'ooo@shop-b.example', 'email_sent', recent, 'touch:3')
    await webhookEvent(neu, 'new@shop-c.example', 'email_sent', recent, 'touch:4')
  })
  afterAll(async () => { await db.close() })

  it('does not add a second copy of a reply or status the webhook saved; auto-replies are not human replies', async () => {
    const replyAt = new Date(Date.now() - 2 * 86400_000 + 60_000).toISOString() // a minute after the webhook's row
    const leads = [
      { id: 'l1', email: 'ann@shop-a.example', campaign: CAMP, lt_interest_status: 1, timestamp_last_reply: replyAt },
      { id: 'l3', email: 'new@shop-c.example', campaign: CAMP, lt_interest_status: 2, timestamp_last_reply: null, timestamp_last_contact: null },
    ]
    const emails = [
      { id: 'e-ann', lead: 'ann@shop-a.example', campaign_id: CAMP, ue_type: 2, subject: 'Re: rewards', timestamp_email: replyAt },
      { id: 'e-ooo', lead: 'ooo@shop-b.example', campaign_id: CAMP, ue_type: 2, subject: 'Automatic reply: Out of Office', timestamp_email: replyAt },
      { id: 'e-new', lead: 'new@shop-c.example', campaign_id: CAMP, ue_type: 2, subject: 'Re: rewards', timestamp_email: replyAt },
    ]
    const s = await reconcileInstantly(db, client(fakeFetch(leads, emails)))
    expect(s.errors).toEqual([])
    const rows = (await db.query<{ type: string; email_norm: string }>(
      "select type, email_norm from lp.lead_events where source = 'instantly_reconcile' order by email_norm, type",
    )).rows
    // Ann: nothing new (reply + status already saved by the webhook).
    expect(rows.filter((r) => r.email_norm === 'ann@shop-a.example')).toEqual([])
    // OOO: an auto-reply, never a human reply.
    expect(rows.filter((r) => r.email_norm === 'ooo@shop-b.example').map((r) => r.type)).toEqual(['auto_reply_received'])
    // New: the reply the webhook missed is filled in; its status with no timestamp is skipped (not dated today).
    expect(rows.filter((r) => r.email_norm === 'new@shop-c.example').map((r) => r.type)).toEqual(['reply_received'])

    const humanReplies = (await db.query<{ n: number }>("select count(*)::int as n from lp.lead_events where type = 'reply_received'")).rows[0].n
    expect(humanReplies).toBe(2) // Ann's (webhook) + New's (reconcile); no duplicate, no OOO

    const again = await reconcileInstantly(db, client(fakeFetch(leads, emails)))
    expect(again.events_inserted).toBe(0)
  })

  it('isAutoReply trusts Instantly\'s flag first, then the subject', () => {
    expect(isAutoReply({ id: 'x', is_auto_reply: 1, subject: 'Re: hi' })).toBe(true)
    expect(isAutoReply({ id: 'x', is_auto_reply: false, subject: 'Out of office' })).toBe(false)
    expect(isAutoReply({ id: 'x', subject: 'Out of Office: back Monday' })).toBe(true)
    expect(isAutoReply({ id: 'x', subject: 'Re: rewards program' })).toBe(false)
  })
})
