import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addSuppression } from '@/lib/suppressions/store'
import { defineField } from '@/lib/fields/store'
import { runCsvImport, CsvImportError } from '@/lib/leads/csv-import'
import { csvObjects } from '@/lib/leads/csv'

describe('lib/leads/csv-import', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
    await addSuppression(db, 'owner', { email: 'blocked@old.com', reason: 'bounced' })
    await defineField(db, 'owner', { entity: 'contact', key: 'referral', label: 'Referral source', type: 'text' })
  })
  afterAll(async () => db.close())

  const mapping = {
    email: 'email', first_name: 'first_name', last_name: 'last_name', phone: 'phone',
    company: 'company_name', website: 'website', referral: 'contact_custom.referral',
  }

  it('dry run: exact counts for duplicates, a suppressed email, a bad row, and a phone-only row -- nothing written', async () => {
    const csv = [
      'email,first_name,last_name,phone,company,website,referral',
      'sara@acme.example,Sara,Lee,,Acme Jewelers,acme.example,friend',
      'sara@acme.example,Sara,Lee,,Acme Jewelers,acme.example,friend', // duplicate within the file
      'blocked@old.com,Bo,Blocked,,Old Co,old.example,',               // suppressed
      'not-an-email,Bad,Row,,Bad Co,,',                                 // invalid: bad email
      ',Phone,Only,5551234567,Call Co,,',                               // phone-only, no email
    ].join('\n')
    const rows = csvObjects(csv)
    const before = await db.query('select count(*)::int as n from lp.contacts')

    const summary = await runCsvImport(db, rows, { mapping, actor: 'owner', dryRun: true })
    expect(summary.total).toBe(5)
    expect(summary.would_create).toBe(2) // sara (first occurrence) + the phone-only row
    expect(summary.skipped_duplicate).toBe(1)
    expect(summary.skipped_suppressed).toBe(1)
    expect(summary.invalid).toBe(1)

    const after = await db.query('select count(*)::int as n from lp.contacts')
    expect(after.rows[0].n).toBe(before.rows[0].n) // dry run wrote nothing
  })

  it('real import creates the rows, maps the custom field, and a phone-only contact is allowed', async () => {
    const csv = [
      'email,first_name,last_name,phone,company,website,referral',
      'maya@brightgems.example,Maya,Chen,,Bright Gems,brightgems.example,trade show',
      ',Walk,In,5557654321,Bright Gems,brightgems.example,',
    ].join('\n')
    const rows = csvObjects(csv)
    const summary = await runCsvImport(db, rows, { mapping, actor: 'owner', dryRun: false })
    expect(summary.would_create).toBe(2)

    const { rows: contacts } = await db.query<{ email: string | null; phone_e164: string | null; custom: Record<string, unknown> }>(
      `select email, phone_e164, custom from lp.contacts where email = 'maya@brightgems.example' or phone_e164 = '+15557654321'`,
    )
    expect(contacts).toHaveLength(2)
    const maya = contacts.find((c) => c.email === 'maya@brightgems.example')!
    expect(maya.custom).toEqual({ referral: 'trade show' })
    const walkIn = contacts.find((c) => c.phone_e164 === '+15557654321')!
    expect(walkIn.email).toBeNull() // phone-only contact, allowed by the 1.13 check constraint

    // both rows matched the same company (by domain)
    const { rows: companies } = await db.query<{ id: number }>(`select id from lp.companies where website_domain = 'brightgems.example'`)
    expect(companies).toHaveLength(1)
  })

  it('an unknown custom-field mapping target is an invalid row, not a crash', async () => {
    const rows = csvObjects('email,gizmo\nx@y.example,42')
    const summary = await runCsvImport(db, rows, { mapping: { email: 'email', gizmo: 'contact_custom.not_defined' }, actor: 'owner', dryRun: true })
    expect(summary.invalid).toBe(1)
    expect(summary.rows[0].reason).toMatch(/not a defined/)
  })

  it('a second import of the same CSV updates instead of re-creating (idempotent re-run)', async () => {
    const csv = 'email,first_name\nrepeat@repeat.example,First'
    const rows = csvObjects(csv)
    const first = await runCsvImport(db, rows, { mapping: { email: 'email', first_name: 'first_name' }, actor: 'owner', dryRun: false })
    expect(first.would_create).toBe(1)
    const second = await runCsvImport(db, rows, { mapping: { email: 'email', first_name: 'first_name' }, actor: 'owner', dryRun: false })
    expect(second.would_update).toBe(1)
    expect(second.would_create).toBe(0)
    const { rows: contacts } = await db.query('select count(*)::int as n from lp.contacts where email_norm = $1', ['repeat@repeat.example'])
    expect(contacts[0].n).toBe(1)
  })

  it('throws CsvImportError on an empty import', async () => {
    await expect(runCsvImport(db, [], { mapping, actor: 'owner', dryRun: true })).rejects.toThrow(CsvImportError)
  })
})
