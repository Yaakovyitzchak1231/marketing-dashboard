import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'
import { emailHash, forgetContact, isForgottenEmail, listRetentionPolicies, retentionSweep, RetentionError, setRetentionPolicy } from '@/lib/retention/store'
import { importLeadRows } from '@/lib/leads/import'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lib/retention/store', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('lists the seeded default policies', async () => {
    const policies = await listRetentionPolicies(db)
    const byCat = Object.fromEntries(policies.map((p) => [p.event_category, p.keep_days]))
    expect(byCat.email_opened).toBe(540)
    expect(byCat.email_sent).toBeNull()
    expect(byCat.reply_received).toBeNull()
  })

  it('owner can edit keep_days', async () => {
    const row = await setRetentionPolicy(db, 'owner', { event_category: 'email_opened', keep_days: 365 })
    expect(row.keep_days).toBe(365)
    const policies = await listRetentionPolicies(db)
    expect(policies.find((p) => p.event_category === 'email_opened')?.keep_days).toBe(365)
    await setRetentionPolicy(db, 'owner', { event_category: 'email_opened', keep_days: 540 }) // restore for later tests
  })

  it('forget_contact requires the typed confirmation and rejects a bad one', async () => {
    const co = await addCompany(db, { name: 'Forget Co' })
    const ct = await addContact(db, co, 'forget-me@example.com')
    await expect(forgetContact(db, 'owner', { contact_id: ct, confirm: 'wrong' })).rejects.toThrow(RetentionError)
    await expect(forgetContact(db, 'owner', { contact_id: 999999, confirm: 'forget' })).rejects.toThrow(/not found/)
  })

  it('forget_contact wipes PII, keeps the tombstone, suppresses by hash (not plaintext), and blocks re-import', async () => {
    const co = await addCompany(db, { name: 'Forget Co 2' })
    const ct = await addContact(db, co, 'Forget-Me2@Example.com')
    await db.query(`update lp.contacts set first_name='Jane', last_name='Doe', phone='5551234567', personalization='likes golf' where id=$1`, [ct])
    await addTouch(db, { companyId: co, contactId: ct, email: 'forget-me2@example.com', event: 'email_opened', at: new Date().toISOString() })
    await db.query(`insert into lp.enrichment (company_id, contact_id, field, value, method) values ($1,$2,'personalization','likes golf','manual')`, [co, ct])
    await db.query(
      `insert into lp.status_history (entity_type, entity_id, field, old_value, new_value, changed_by, via) values ('contact', $1, 'email', 'old@x.com', 'forget-me2@example.com', 'owner', 'ui')`,
      [ct],
    )

    const result = await forgetContact(db, 'owner', { contact_id: ct, confirm: 'forget-me2@example.com' })
    expect(result).toEqual({ ok: true, contact_id: ct, suppressed: true })

    const { rows } = await db.query('select * from lp.contacts where id = $1', [ct])
    expect(rows[0].email).toBeNull()
    expect(rows[0].email_norm).toBeNull()
    expect(rows[0].first_name).toBeNull()
    expect(rows[0].last_name).toBeNull()
    expect(rows[0].phone).toBeNull()
    expect(rows[0].personalization).toBeNull()
    expect(rows[0].do_not_contact).toBe(true)
    expect(Number(rows[0].company_id)).toBe(co) // tombstone: the row and its company membership survive

    const { rows: enr } = await db.query('select count(*)::int as n from lp.enrichment where contact_id = $1', [ct])
    expect(Number(enr[0].n)).toBe(0)
    const { rows: touch } = await db.query('select email from lp.campaign_touches where contact_id = $1', [ct])
    expect(touch[0].email).toBeNull()
    const { rows: hist } = await db.query("select count(*)::int as n from lp.status_history where entity_type='contact' and entity_id=$1 and field='email'", [ct])
    expect(Number(hist[0].n)).toBe(0) // the old-email history row was cleared
    const { rows: forgottenMark } = await db.query("select new_value from lp.status_history where entity_type='contact' and entity_id=$1 and field='forgotten'", [ct])
    expect(forgottenMark[0].new_value).toBe('true')

    // Suppressed by HASH, never by the plaintext address.
    const { rows: supp } = await db.query('select email_norm, email_hash from lp.suppressions where email_hash = $1', [emailHash('forget-me2@example.com')])
    expect(supp).toHaveLength(1)
    expect(supp[0].email_norm).toBeNull()
    expect(await isForgottenEmail(db, 'forget-me2@example.com')).toBe(true)
    expect(await isForgottenEmail(db, 'FORGET-me2@EXAMPLE.com')).toBe(true)
    expect(await isForgottenEmail(db, 'someone-else@example.com')).toBe(false)

    // Blocks re-import of the same email via the import path.
    const s = await importLeadRows(db, [{ email: 'forget-me2@example.com', company_name: 'Forget Co 2 Reimport', status: 'new' }], { year: 2026 })
    expect(s.skipped_forgotten).toBe(1)
    const { rows: reimported } = await db.query("select count(*)::int as n from lp.contacts where email_norm = 'forget-me2@example.com'")
    expect(Number(reimported[0].n)).toBe(0)
  })

  it('a contact with no email confirms with "forget"', async () => {
    const co = await addCompany(db, { name: 'No Email Co' })
    // do_not_contact: true -- plan 1.13's contacts_email_or_phone_chk (0025) requires one of
    // email/phone on an active contact; a contact that already has neither is already do-not-contact.
    const { rows } = await db.query<{ id: number }>(`insert into lp.contacts (company_id, first_name, do_not_contact) values ($1, 'NoEmail', true) returning id`, [co])
    const ct = rows[0].id
    const result = await forgetContact(db, 'owner', { contact_id: ct, confirm: 'forget' })
    expect(result.suppressed).toBe(false)
  })

  it('rejects forgetting an already-merged contact', async () => {
    const co = await addCompany(db, { name: 'Merge Then Forget' })
    const a = await addContact(db, co, 'a@example.com')
    const b = await addContact(db, co, 'b@example.com')
    await db.query('update lp.contacts set merged_into = $1 where id = $2', [a, b])
    await expect(forgetContact(db, 'owner', { contact_id: b, confirm: 'b@example.com' })).rejects.toThrow(/merged into/)
  })

  it('retention_sweep deletes only events past policy, in the right category', async () => {
    const co = await addCompany(db, { name: 'Sweep Co' })
    const old = new Date(Date.now() - 600 * 86400 * 1000).toISOString()
    const recent = new Date(Date.now() - 10 * 86400 * 1000).toISOString()
    await addTouch(db, { companyId: co, event: 'email_opened', at: old })
    await addTouch(db, { companyId: co, event: 'email_opened', at: recent })
    await addTouch(db, { companyId: co, event: 'email_sent', at: old }) // forever category: never swept
    await addTouch(db, { companyId: co, event: 'reply_received', at: old }) // forever category: never swept

    const result = await retentionSweep(db, 'system')
    const opened = result.swept.find((s) => s.event_category === 'email_opened')
    expect(opened?.deleted).toBe(1)
    expect(result.total_deleted).toBe(1)

    const { rows } = await db.query<{ event_type: string }>('select event_type from lp.campaign_touches where company_id = $1 order by event_type', [co])
    expect(rows.map((r) => r.event_type).sort()).toEqual(['email_opened', 'email_sent', 'reply_received'])
  })
})
