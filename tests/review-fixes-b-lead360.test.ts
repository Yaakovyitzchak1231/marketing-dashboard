import { describe, it, expect, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { getLeadProfile } from '@/lib/leads/profile'

// Review fixes (#79, Viktor): "Sendable" showed for a lead with no email; milestones only
// looked at the newest 200 events.
describe('Lead 360 review fixes (#79)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('no email is not "Sendable"; do-not-contact is not "Sendable"; milestones see the whole history', async () => {
    db = await createTestDb()
    const noEmail = await addCompany(db, { name: 'Phone Only' })
    await db.query(`insert into lp.contacts (company_id, phone, phone_e164) values ($1, '410-555-0101', '+14105550101')`, [noEmail])
    const p1 = (await getLeadProfile(db, noEmail))!
    expect(p1.suppression.no_email).toBe(true)
    expect(p1.suppression.suppressed).toBe(false)

    const dnc = await addCompany(db, { name: 'Do Not Contact' })
    await db.query(`insert into lp.contacts (company_id, email, email_norm, do_not_contact) values ($1, 'dnc@x.test', 'dnc@x.test', true)`, [dnc])
    const p2 = (await getLeadProfile(db, dnc))!
    expect(p2.suppression.no_email).toBeFalsy()
    expect(p2.suppression.suppressed).toBe(true)

    const busy = await addCompany(db, { name: 'Busy Lead' })
    await addContact(db, busy, 'busy@x.test')
    const old = new Date(Date.now() - 300 * 86_400_000).toISOString()
    await db.query(`insert into lp.lead_events (company_id, type, occurred_at, source) values ($1, 'reply_received', $2, 'backfill')`, [busy, old])
    await db.query(
      `insert into lp.lead_events (company_id, type, occurred_at, source)
       select $1, 'email_opened', now() - (g || ' minutes')::interval, 'backfill' from generate_series(1, 210) g`,
      [busy],
    )
    const p3 = (await getLeadProfile(db, busy))!
    expect(p3.detail.events.length).toBe(200) // the timeline still shows the latest 200
    expect(p3.milestones.first_reply).toBe(old)
    expect(p3.milestones.first_touch).toBe(old)
    expect(p3.milestones.first_open).not.toBeNull()
  })
})
