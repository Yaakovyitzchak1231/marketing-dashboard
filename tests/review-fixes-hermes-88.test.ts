import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
const role = { current: 'owner' as 'viewer' | 'editor' | 'owner' | null }
const dbRef: { current: unknown } = { current: null }
vi.mock('@/lib/db', () => ({ getDb: () => dbRef.current }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => role.current,
  currentEmail: async () => 'x@example.com',
  currentActorId: async () => 'owner',
}))
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { clearSecretAction } from '@/app/actions/settings'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

// Hermes' review on #88: under lp.maintenance (Forget), only email_norm and props may change
// on a timeline row. Every other column is pinned and no id may be nulled there.
describe('Hermes #88: lp.lead_events maintenance branch pins every column but email_norm/props', () => {
  let db: TestDb
  let co: number
  let ct: number
  let campaignId: number
  let evId: number
  beforeAll(async () => {
    db = await createTestDb()
    co = await addCompany(db, { name: 'Pin Co' })
    ct = await addContact(db, co, 'pin@pin.example')
    campaignId = Number((await db.query<{ id: number }>(`insert into lp.campaigns (name) values ('Pin campaign') returning id`)).rows[0].id)
    evId = Number((await db.query<{ id: number }>(
      `insert into lp.lead_events (type, company_id, contact_id, campaign_id, email_norm, instantly_campaign_id, step, source, actor, props, dedupe_key)
       values ('email_sent', $1, $2, $3, 'pin@pin.example', 'inst-1', 2, 'manual', 'owner', '{"email":"pin@pin.example","step":2}', 'pin1') returning id`,
      [co, ct, campaignId],
    )).rows[0].id)
  })
  afterAll(async () => { await db.close() })

  const underMaintenance = (sql: string, params: unknown[] = []) =>
    db.tx(async (q) => {
      await q.query("select set_config('lp.maintenance', 'on', true)")
      await q.query(sql, params)
    }, 'owner')

  it('allows scrubbing email_norm and props (what Forget does)', async () => {
    await underMaintenance(`update lp.lead_events set email_norm = null, props = props - 'email' where id = $1`, [evId])
    const r = await db.query<{ email_norm: string | null; props: Record<string, unknown> }>(`select email_norm, props from lp.lead_events where id = $1`, [evId])
    expect(r.rows[0]).toEqual({ email_norm: null, props: { step: 2 } })
  })

  it.each([
    ['instantly_campaign_id', `instantly_campaign_id = 'other'`],
    ['step', `step = 9`],
    ['actor', `actor = null`],
    ['recorded_at', `recorded_at = now() - interval '1 day'`],
    ['occurred_at', `occurred_at = now() - interval '1 day'`],
    ['type', `type = 'email_opened'`],
    ['source', `source = 'other'`],
    ['dedupe_key', `dedupe_key = 'pin2'`],
    ['company_id -> NULL', `company_id = null`],
    ['contact_id -> NULL', `contact_id = null`],
    ['campaign_id -> NULL', `campaign_id = null`],
    ['company_id -> NULL with a props scrub', `company_id = null, props = '{}'::jsonb`],
    ['instantly_campaign_id with an email scrub', `instantly_campaign_id = null, email_norm = null`],
  ])('rejects a change to %s under maintenance', async (_name, set) => {
    await expect(underMaintenance(`update lp.lead_events set ${set} where id = $1`, [evId])).rejects.toThrow(/append-only/)
    const r = await db.query<{ company_id: number; contact_id: number; campaign_id: number; instantly_campaign_id: string; step: number; actor: string; dedupe_key: string }>(
      `select company_id::int, contact_id::int, campaign_id::int, instantly_campaign_id, step, actor, dedupe_key from lp.lead_events where id = $1`, [evId])
    expect(r.rows[0]).toEqual({ company_id: co, contact_id: ct, campaign_id: campaignId, instantly_campaign_id: 'inst-1', step: 2, actor: 'owner', dedupe_key: 'pin1' })
  })

  it('without maintenance, a direct UPDATE cannot null an id either', async () => {
    await expect(db.query(`update lp.lead_events set company_id = null where id = $1`, [evId])).rejects.toThrow(/append-only/)
  })

  it('without maintenance, even email_norm/props cannot change', async () => {
    await expect(db.query(`update lp.lead_events set email_norm = 'x@x.example' where id = $1`, [evId])).rejects.toThrow(/append-only/)
  })

  it('deleting the contact still nulls contact_id through the FK (0018 rule kept)', async () => {
    const c2 = await addContact(db, co, 'fk@pin.example')
    await db.query(`insert into lp.lead_events (type, contact_id, source, dedupe_key) values ('email_sent', $1, 'manual', 'pin-fk')`, [c2])
    await db.tx(async (q) => {
      await q.query("select set_config('lp.maintenance', 'on', true)")
      await q.query(`delete from lp.contacts where id = $1`, [c2])
    }, 'owner')
    const r = await db.query<{ contact_id: number | null }>(`select contact_id from lp.lead_events where dedupe_key = 'pin-fk'`)
    expect(r.rows[0].contact_id).toBeNull()
  })
})

// Hermes' review on #88: clearSecretAction threw (a 500 page). It now returns the message.
describe('Hermes #88: clearSecretAction returns a friendly message instead of throwing', () => {
  beforeEach(() => { dbRef.current = null; role.current = 'owner' })
  const fd = (confirm = 'yes') => { const f = new FormData(); f.set('key', 'instantly.api_key'); f.set('confirm', confirm); return f }

  it('a Viewer gets a message, not an exception', async () => {
    role.current = 'viewer'
    const r = await clearSecretAction(null, fd())
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/owner/i)
  })

  it('a database failure comes back as a message, not an exception', async () => {
    const r = await clearSecretAction(null, fd())
    expect(r.ok).toBe(false)
    expect(r.message).toMatch(/not connected/)
  })

  it('unconfirmed clears nothing and says so', async () => {
    const r = await clearSecretAction(null, fd('no'))
    expect(r).toEqual({ ok: false, message: 'Nothing was cleared (not confirmed).' })
  })
})
