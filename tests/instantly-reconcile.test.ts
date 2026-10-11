import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { InstantlyClient } from '@/lib/instantly/client'
import { reconcileInstantly } from '@/lib/instantly/reconcile'
import { fakeInstantly } from './helpers/instantly-fake'
import { createTestDb } from './helpers/pglite-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

async function seedContact(email: string): Promise<{ companyId: number; contactId: number }> {
  const domain = email.split('@')[1]
  const co = await db.query<{ id: number }>(
    "insert into lp.companies (name, website_domain, stage) values ($1, $2, 'in_campaign') returning id",
    [domain, domain],
  )
  const companyId = co.rows[0].id
  const c = await db.query<{ id: number }>(
    "insert into lp.contacts (company_id, email, email_norm, status, verification_status) values ($1, $2, $2, 'in-Instantly', 'valid') returning id",
    [companyId, email],
  )
  const contactId = c.rows[0].id
  // A prior webhook touch is what makes knownContacts() pick this contact up.
  await db.query(
    "insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, source, dedupe_key) values (now() - interval '1 day', 'email_sent', $1, $2, $3, 'instantly_webhook', $4)",
    [companyId, contactId, email, `seed:${email}`],
  )
  return { companyId, contactId }
}

beforeAll(async () => {
  db = await createTestDb()
  for (const email of ['ann@shop-a.example', 'bob@shop-b.example', 'bounce@shop-c.example', 'old@shop-d.example']) {
    await seedContact(email)
  }
})
afterAll(async () => {
  await db.close()
})

function client(fetchImpl: typeof fetch) {
  return new InstantlyClient({ apiKey: 'test-key', fetchImpl, backoffMs: 0, memoTtlMs: 0, sleep: async () => {} })
}

describe('reconcileInstantly', () => {
  it('fills in interest-status and reply events the webhook missed, for known contacts only', async () => {
    const { fetchImpl, calls } = fakeInstantly()
    const summary = await reconcileInstantly(db, client(fetchImpl))

    expect(summary.contacts_checked).toBe(4)
    expect(summary.leads_fetched).toBe(4)
    expect(summary.errors).toEqual([])
    // ann: interested (status 1) + a received reply. bob: no status, sent-not-received thread -> nothing.
    // bounce: no status, one received reply. old: No Show (-4, unmapped -> custom) + a received reply.
    expect(summary.events_inserted).toBe(5)
    expect(summary.events_skipped_duplicate).toBe(0)

    const postedBody = calls.find((c) => c.path === '/leads/list')?.body as { contacts: string[] }
    expect(postedBody.contacts.sort()).toEqual(['ann@shop-a.example', 'bob@shop-b.example', 'bounce@shop-c.example', 'old@shop-d.example'])

    const rows = await db.query<{ type: string; email_norm: string; props: Record<string, unknown> }>(
      "select type, email_norm, props from lp.lead_events where source = 'instantly_reconcile' order by email_norm, type",
    )
    expect(rows.rows).toContainEqual(expect.objectContaining({ type: 'lead_interested', email_norm: 'ann@shop-a.example' }))
    expect(rows.rows).toContainEqual(expect.objectContaining({ type: 'reply_received', email_norm: 'ann@shop-a.example' }))
    expect(rows.rows).toContainEqual(expect.objectContaining({ type: 'reply_received', email_norm: 'bounce@shop-c.example' }))
    expect(rows.rows.find((r) => r.email_norm === 'bob@shop-b.example')).toBeUndefined()
    const oldCustom = rows.rows.find((r) => r.email_norm === 'old@shop-d.example' && r.type === 'custom')
    expect(oldCustom?.props).toMatchObject({ lt_interest_status: -4 })
  })

  it('is idempotent: a second run against the same Instantly state inserts nothing new', async () => {
    const { fetchImpl } = fakeInstantly()
    const summary = await reconcileInstantly(db, client(fetchImpl))
    expect(summary.events_considered).toBeGreaterThan(0)
    expect(summary.events_inserted).toBe(0)
    expect(summary.events_skipped_duplicate).toBe(summary.events_considered)
  })

  it('records the Instantly error and still returns a summary when a call fails', async () => {
    const { fetchImpl } = fakeInstantly((call) => {
      if (call.path === '/leads/list') return new Response(JSON.stringify({ message: 'nope' }), { status: 500 })
      return undefined
    })
    const summary = await reconcileInstantly(db, client(fetchImpl))
    expect(summary.errors.some((e) => e.includes('listLeadsByEmail'))).toBe(true)
    // the thread-reply half still ran
    expect(summary.threads_fetched).toBeGreaterThan(0)
  })

  it('checks nobody when there are no known Instantly contacts', async () => {
    const empty = await createTestDb()
    const { fetchImpl } = fakeInstantly()
    const summary = await reconcileInstantly(empty, client(fetchImpl))
    expect(summary).toMatchObject({ contacts_checked: 0, leads_fetched: 0, threads_fetched: 0, events_inserted: 0 })
    await empty.close()
  })
})
