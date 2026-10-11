import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { merge } from '@/lib/merge/merge'
import { forgetContact, emailHash } from '@/lib/retention/store'
import { importLeadRows } from '@/lib/leads/import'
import { checkEmails } from '@/lib/suppressions/store'
import { createCampaign } from '@/lib/campaigns/store'
import { parseCampaignPatch } from '@/lib/campaigns/types'
import { runOp } from '@/lib/ops/dispatch'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Viktor's #81 review (+ the e2e worker's addition): merge must move campaign membership,
// events, files, lists and consent to the survivor; contact merge must not trip the email
// unique index; company merge must hand the dedupe keys to the survivor; Forget must clear
// every copy of the person's data.
describe('review fix #81: merge moves everything, Forget clears everything', () => {
  let db: TestDb
  let campaignId: number
  beforeAll(async () => {
    db = await createTestDb()
    const c = await createCampaign(db, 'owner', parseCampaignPatch({ name: 'Merge test', pool: 'jeweler' }, { create: true }) as { name: string })
    campaignId = c.id
  })
  afterAll(async () => { await db.close() })

  it('company merge moves campaign membership, events, files, lists; imports then match the survivor', async () => {
    const keep = await addCompany(db, { name: 'Keep Co', state: 'MD' })
    const loser = await addCompany(db, { name: 'Loser Co', state: 'MD', domain: 'loser.example' })
    await db.query(`insert into lp.campaign_leads (campaign_id, company_id) values ($1, $2)`, [campaignId, loser])
    await db.query(`insert into lp.lead_events (type, company_id, source, dedupe_key) values ('email_sent', $1, 'manual', 'm1')`, [loser])
    await db.query(`insert into lp.files (company_id, name, url) values ($1, 'deck.pdf', 'https://x.example/deck.pdf')`, [loser])
    const list = (await runOp(db, 'tab', 'create_segment', { name: 'VIPs', entity: 'company', kind: 'static', definition: { entity: 'company', include: [] } })) as { id: number }
    await runOp(db, 'tab', 'segment_add_members', { id: list.id, company_ids: [loser] })

    await merge(db, 'owner', { entity: 'company', keep, merge: loser, choices: {} })

    const one = async (sql: string, p: unknown[]) => Number((await db.query<{ n: number }>(sql, p)).rows[0].n)
    expect(await one(`select count(*)::int n from lp.campaign_leads where company_id = $1`, [keep])).toBe(1)
    expect(await one(`select count(*)::int n from lp.lead_events where company_id = $1 and dedupe_key = 'm1'`, [keep])).toBe(1)
    expect(await one(`select count(*)::int n from lp.files where company_id = $1`, [keep])).toBe(1)
    expect(await one(`select count(*)::int n from lp.segment_members where company_id = $1`, [keep])).toBe(1)
    expect(await one(`select count(*)::int n from lp.campaign_leads where company_id = $1`, [loser])).toBe(0)
    const { rows } = await db.query<{ website_domain: string | null }>(`select website_domain from lp.companies where id = $1`, [keep])
    expect(rows[0].website_domain).toBe('loser.example')

    // A later import of the loser's domain attaches to the survivor, not the hidden row.
    await importLeadRows(db, [{ company_name: 'Loser Co', website: 'https://loser.example', email: 'new@loser.example' }], { year: 2026 })
    const ct = await db.query<{ company_id: number }>(`select company_id from lp.contacts where email_norm = 'new@loser.example'`)
    expect(Number(ct.rows[0].company_id)).toBe(keep)
  })

  it('contact merge choosing the merged row\'s email works, and an unsubscribe keeps protecting the survivor', async () => {
    const co = await addCompany(db, { name: 'People Co' })
    const keep = await addContact(db, co, 'Keep@People.example')
    const loser = await addContact(db, co, 'gone@people.example')
    await db.query(`update lp.contacts set subscription_status = 'unsubscribed' where id = $1`, [loser])
    await db.query(`insert into lp.consent_log (contact_id, status, source) values ($1, 'unsubscribed', 'manual')`, [loser])
    await db.query(`insert into lp.suppressions (email_norm, reason, source) values ('gone@people.example', 'unsubscribed', 'manual')`)
    await db.query(`insert into lp.campaign_leads (campaign_id, company_id, contact_id) values ($1, $2, $3)`, [campaignId, co, loser])
    await db.query(`insert into lp.lead_events (type, contact_id, source, dedupe_key) values ('reply_received', $1, 'manual', 'm2')`, [loser])

    // Pick the LOSER's email: used to fail on contacts_email_uq.
    await merge(db, 'owner', { entity: 'contact', keep, merge: loser, choices: { email: 'merge' } })
    const k = (await db.query<{ email_norm: string; subscription_status: string }>(`select email_norm, subscription_status from lp.contacts where id = $1`, [keep])).rows[0]
    expect(k.email_norm).toBe('gone@people.example')
    expect(k.subscription_status).toBe('unsubscribed')
    const n = async (sql: string) => Number((await db.query<{ n: number }>(sql, [keep])).rows[0].n)
    expect(await n(`select count(*)::int n from lp.consent_log where contact_id = $1`)).toBe(1)
    expect(await n(`select count(*)::int n from lp.campaign_leads where contact_id = $1`)).toBe(1)
    expect(await n(`select count(*)::int n from lp.lead_events where contact_id = $1 and dedupe_key = 'm2'`)).toBe(1)
  })

  it('an unsubscribe on the merged-away address protects the survivor\'s different address', async () => {
    const co = await addCompany(db, { name: 'Two Addr Co' })
    const keep = await addContact(db, co, 'a@twoaddr.example')
    const loser = await addContact(db, co, 'b@twoaddr.example')
    await db.query(`insert into lp.suppressions (email_norm, reason, source) values ('b@twoaddr.example', 'unsubscribed', 'manual')`)
    await merge(db, 'owner', { entity: 'contact', keep, merge: loser, choices: {} })
    const chk = await checkEmails(db, ['a@twoaddr.example'])
    expect(chk['a@twoaddr.example'].suppressed).toBe(true)
  })

  it('Forget clears the person, rows merged into them, event emails and plaintext suppressions (still blocked by hash)', async () => {
    const co = await addCompany(db, { name: 'Forget Co' })
    const keep = await addContact(db, co, 'me@forget.example')
    const loser = await addContact(db, co, 'old@forget.example')
    await db.query(`update lp.contacts set first_name = 'Pat' where id = $1`, [loser])
    await merge(db, 'owner', { entity: 'contact', keep, merge: loser, choices: {} })
    await db.query(`insert into lp.lead_events (type, contact_id, email_norm, source, dedupe_key) values ('email_sent', $1, 'me@forget.example', 'manual', 'm3')`, [keep])
    await db.query(`insert into lp.suppressions (email_norm, reason, source) values ('old@forget.example', 'bounced', 'manual')`)

    await forgetContact(db, 'owner', { contact_id: keep, confirm: 'me@forget.example' })

    const left = await db.query<{ email: string | null; first_name: string | null }>(`select email, first_name from lp.contacts where id in ($1, $2)`, [keep, loser])
    expect(left.rows.every((r) => r.email === null && r.first_name === null)).toBe(true)
    const ev = await db.query(`select 1 from lp.lead_events where email_norm in ('me@forget.example', 'old@forget.example')`)
    expect(ev.rows).toHaveLength(0)
    const plain = await db.query(`select 1 from lp.suppressions where email_norm in ('me@forget.example', 'old@forget.example')`)
    expect(plain.rows).toHaveLength(0)
    const hashed = await db.query(`select 1 from lp.suppressions where email_hash = $1`, [emailHash('old@forget.example')])
    expect(hashed.rows.length).toBeGreaterThan(0)
    // The send-time checks still block both addresses.
    const chk = await checkEmails(db, ['me@forget.example', 'old@forget.example'])
    expect(chk['me@forget.example'].suppressed).toBe(true)
    expect(chk['old@forget.example'].suppressed).toBe(true)
    const sql = await db.query<{ s: boolean }>(`select lp.is_suppressed('old@forget.example') as s`)
    expect(sql.rows[0].s).toBe(true)
  })
})
