import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { editCompany, editContact, LeadEditError, parsePatch, CONTACT_EDIT_FIELDS, EDITABLE_CONTACT_STATUSES } from '@/lib/leads/edit'
import { getLeadDetail } from '@/lib/leads/detail'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { PATCH as patchCompany } from '@/app/api/leads/[id]/route'
import { PATCH as patchContact } from '@/app/api/leads/[id]/contacts/[contactId]/route'

const companyReq = (id: string, body: unknown) =>
  patchCompany(new Request(`http://x/api/leads/${id}`, { method: 'PATCH', body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
const contactReq = (id: string, contactId: string, body: unknown) =>
  patchContact(new Request(`http://x/api/leads/${id}/contacts/${contactId}`, { method: 'PATCH', body: JSON.stringify(body) }), {
    params: Promise.resolve({ id, contactId }),
  })

async function history(db: TestDb, type: string, id: number) {
  const { rows } = await db.query<{ field: string; old_value: string | null; new_value: string | null; changed_by: string }>(
    `select field, old_value, new_value, changed_by from lp.status_history where entity_type = $1 and entity_id = $2 order by id`,
    [type, id],
  )
  return rows
}
async function lastEvent(db: TestDb, kind: string) {
  const { rows } = await db.query<{ actor: string; summary: string; entity_id: string; data: { changes: unknown[]; verification_reset?: boolean } }>(
    `select actor, summary, entity_id, data from lp.events where kind = $1 order by id desc limit 1`,
    [kind],
  )
  return rows[0]
}

describe('manual lead editing (real Postgres via PGlite)', () => {
  let db: TestDb
  let gem: number
  let other: number
  beforeAll(async () => {
    db = await createTestDb()
    gem = await addCompany(db, { name: 'Gem Co', state: 'MD', city: 'Baltimore', domain: 'gemco.com' })
    other = await addCompany(db, { name: 'Ring Bros', state: 'MD', city: 'Towson', domain: 'ringbros.com' })
    await addContact(db, other, 'sales@ringbros.com', 'valid', { role: true })
  })
  afterAll(async () => {
    await db.close()
  })

  it('migration 0007: contacts have a phone; the held statuses are pickable', async () => {
    const id = await addContact(db, gem, 'held@gemco.com', 'unverified', { status: 'role-based-hold' })
    await db.query(`update lp.contacts set status = 'needs-check', phone = '410-555-0100' where id = $1`, [id])
    expect(EDITABLE_CONTACT_STATUSES).toContain('role-based-hold')
    expect(EDITABLE_CONTACT_STATUSES).toContain('needs-check')
    await expect(db.query(`update lp.contacts set status = 'bogus' where id = $1`, [id])).rejects.toThrow()
  })

  it('edits contact fields: only what changed, history rows per field, one activity event with old -> new', async () => {
    const id = await addContact(db, gem, 'ruth@gemco.com', 'unverified')
    const r = await editContact(db, gem, id, { first_name: 'Ruth', last_name: 'Gold', title: 'Owner', phone: '(410) 555-0101' }, 'owner')
    expect(r.changes.map((c) => c.field)).toEqual(['first_name', 'last_name', 'title', 'phone'])
    expect(r.contact).toMatchObject({ first_name: 'Ruth', last_name: 'Gold', title: 'Owner', phone: '(410) 555-0101', phone_e164: '+14105550101', name_source: 'manual' })
    expect(await history(db, 'contact', id)).toEqual(
      expect.arrayContaining([
        { field: 'first_name', old_value: null, new_value: 'Ruth', changed_by: 'owner' },
        { field: 'title', old_value: null, new_value: 'Owner', changed_by: 'owner' },
      ]),
    )
    const ev = await lastEvent(db, 'lead.contact_edited')
    expect(ev.actor).toBe('owner')
    expect(ev.entity_id).toBe(String(gem))
    expect(ev.summary).toBe('Yaakov edited ruth@gemco.com at Gem Co: first name (blank) → Ruth; last name (blank) → Gold; title (blank) → Owner; phone (blank) → (410) 555-0101')
    expect(ev.data.changes).toHaveLength(4)

    // Saving the same values again writes nothing.
    const before = (await db.query<{ n: number }>(`select count(*)::int as n from lp.events`)).rows[0].n
    const again = await editContact(db, gem, id, { first_name: ' Ruth ', title: 'Owner' }, 'owner')
    expect(again.changes).toEqual([])
    expect((await db.query<{ n: number }>(`select count(*)::int as n from lp.events`)).rows[0].n).toBe(before)
  })

  it('changing the email re-normalizes it and resets verification; a valid-ready status starts over', async () => {
    const id = await addContact(db, gem, 'old@gemco.com', 'valid', { status: 'valid-ready' })
    await db.query(`update lp.contacts set verified_at = now(), verified_by = 'millionverifier' where id = $1`, [id])
    const r = await editContact(db, gem, id, { email: '  New.Owner@GemCo.com ' }, 'owner')
    expect(r.verification_reset).toBe(true)
    expect(r.contact).toMatchObject({
      email: 'new.owner@gemco.com', email_norm: 'new.owner@gemco.com', verification_status: 'unverified',
      verified_at: null, verified_by: null, status: 'new', email_source: 'manual', is_role_address: false,
    })
    const h = await history(db, 'contact', id)
    expect(h).toEqual(
      expect.arrayContaining([
        { field: 'email', old_value: 'old@gemco.com', new_value: 'new.owner@gemco.com', changed_by: 'owner' },
        { field: 'verification_status', old_value: 'valid', new_value: 'unverified', changed_by: 'owner' },
        { field: 'status', old_value: 'valid-ready', new_value: 'new', changed_by: 'owner' },
      ]),
    )
    const ev = await lastEvent(db, 'lead.contact_edited')
    expect(ev.data.verification_reset).toBe(true)
    expect(ev.summary).toContain('email old@gemco.com → new.owner@gemco.com')
  })

  it('role-based-hold is never auto-converted, even when the email changes to a personal address', async () => {
    const id = await addContact(db, gem, 'info@gemco.com', 'valid', { status: 'role-based-hold', role: true })
    const r = await editContact(db, gem, id, { email: 'dana@gemco.com' }, 'owner')
    expect(r.contact.status).toBe('role-based-hold')
    expect(r.contact.is_role_address).toBe(false)
    expect(r.contact.verification_status).toBe('unverified')
    // ...and a person can pick it by hand.
    const id2 = await addContact(db, gem, 'shop@gemco.com', 'unverified', { role: true })
    const r2 = await editContact(db, gem, id2, { status: 'role-based-hold' }, 'owner')
    expect(r2.contact.status).toBe('role-based-hold')
  })

  it('a status the person picks wins over the email-change reset', async () => {
    const id = await addContact(db, gem, 'x1@gemco.com', 'valid', { status: 'valid-ready' })
    const r = await editContact(db, gem, id, { email: 'x2@gemco.com', status: 'needs-check' }, 'owner')
    expect(r.contact.status).toBe('needs-check')
  })

  it('rejects bad input with a clear message and changes nothing', async () => {
    const id = await addContact(db, gem, 'keep@gemco.com', 'valid', { status: 'valid-ready' })
    const bad = async (p: Parameters<typeof editContact>[3], status: number, msg: RegExp) => {
      const err = await editContact(db, gem, id, p, 'owner').catch((e) => e)
      expect(err).toBeInstanceOf(LeadEditError)
      expect(err.status).toBe(status)
      expect(err.message).toMatch(msg)
    }
    await bad({ email: 'not-an-email' }, 400, /not a valid email/)
    await bad({ email: 'a@b' }, 400, /not a valid email/)
    await bad({ email: null }, 400, /can’t be blank/)
    await bad({ email: 'SALES@ringbros.com' }, 409, /already a contact on Ring Bros/)
    await bad({ status: 'thrown-out' }, 400, /Status must be one of/)
    await bad({ phone: '12' }, 400, /phone number/)
    const row = (await db.query<{ email: string; status: string }>(`select email, status from lp.contacts where id = $1`, [id])).rows[0]
    expect(row).toEqual({ email: 'keep@gemco.com', status: 'valid-ready' })
    // A contact must belong to the lead in the URL.
    const err = await editContact(db, other, id, { title: 'x' }, 'owner').catch((e) => e)
    expect(err.status).toBe(404)
  })

  it('parsePatch refuses unknown fields and non-text values', () => {
    expect(() => parsePatch({ do_not_contact: true }, CONTACT_EDIT_FIELDS)).toThrow(/can't be edited/)
    expect(() => parsePatch({ title: 5 }, CONTACT_EDIT_FIELDS)).toThrow(/must be text/)
    expect(() => parsePatch({}, CONTACT_EDIT_FIELDS)).toThrow(/Nothing to change/)
    expect(parsePatch({ title: '  ', first_name: ' Ann ' }, CONTACT_EDIT_FIELDS)).toEqual({ title: null, first_name: 'Ann' })
  })

  it('edits company fields: website/phone re-normalize, dedupe conflicts are 409, history + event written', async () => {
    const r = await editCompany(db, gem, { name: 'Gem Co Jewelers', website: 'https://www.GemCoJewelers.com/about', phone: '410 555 0199', city: 'Towson', state: 'md' }, 'owner')
    expect(r.company).toMatchObject({
      name: 'Gem Co Jewelers', website: 'https://www.GemCoJewelers.com/about', website_domain: 'gemcojewelers.com',
      phone_e164: '+14105550199', city: 'Towson', state: 'MD',
    })
    expect(r.changes.map((c) => c.field)).toEqual(['name', 'city', 'website', 'phone'])
    const h = await history(db, 'company', gem)
    expect(h).toEqual(expect.arrayContaining([{ field: 'name', old_value: 'Gem Co', new_value: 'Gem Co Jewelers', changed_by: 'owner' }]))
    const ev = await lastEvent(db, 'lead.company_edited')
    expect(ev.actor).toBe('owner')
    expect(ev.summary).toMatch(/^Yaakov edited Gem Co: name Gem Co → Gem Co Jewelers; city Baltimore → Towson; website/)

    const dup = await editCompany(db, gem, { website: 'ringbros.com' }, 'owner').catch((e) => e)
    expect(dup.status).toBe(409)
    expect(dup.message).toMatch(/already the website of Ring Bros/)
    const badSite = await editCompany(db, gem, { website: 'not a site' }, 'owner').catch((e) => e)
    expect(badSite.status).toBe(400)
    const blank = await editCompany(db, gem, { name: null }, 'owner').catch((e) => e)
    expect(blank.status).toBe(400)
  })

  it('lead detail history shows the field edits with who made them', async () => {
    const d = (await getLeadDetail(db, gem))!
    const fields = d.history.map((h) => h.field)
    expect(fields).toEqual(expect.arrayContaining(['name', 'website', 'email', 'first_name']))
    expect(d.history.find((h) => h.field === 'name')?.changed_by_name).toBe('Yaakov')
  })

  it('routes: 503 without a database, 400/404/409 mapped, 200 with changes', async () => {
    holder.db = null
    expect((await companyReq(String(gem), { city: 'X' })).status).toBe(503)
    expect((await contactReq(String(gem), '1', { title: 'X' })).status).toBe(503)
    holder.db = db
    expect((await companyReq('abc', { city: 'X' })).status).toBe(404)
    expect((await companyReq('999999', { city: 'X' })).status).toBe(404)
    expect((await companyReq(String(gem), { stage: 'won' })).status).toBe(400)
    const ok = await companyReq(String(gem), { city: 'Pikesville' })
    expect(ok.status).toBe(200)
    expect((await ok.json()).changes).toEqual([{ field: 'city', from: 'Towson', to: 'Pikesville' }])

    const id = await addContact(db, gem, 'route@gemco.com', 'unverified')
    expect((await contactReq(String(gem), String(id), { email: 'nope' })).status).toBe(400)
    expect((await contactReq(String(gem), String(id), { email: 'sales@ringbros.com' })).status).toBe(409)
    expect((await contactReq(String(other), String(id), { title: 'x' })).status).toBe(404)
    const res = await contactReq(String(gem), String(id), { email: 'Route2@gemco.com', status: 'role-based-hold' })
    expect(res.status).toBe(200)
    const j = await res.json()
    expect(j.verification_reset).toBe(true)
    expect(j.contact.status).toBe('role-based-hold')
  })
})
