import { describe, it, expect, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runCsvImport } from '@/lib/leads/csv-import'

// Review fix (#76, Viktor): a CSV row with a company phone but no company name or
// website skipped the company lookup, inserted a duplicate phone, and the whole
// import (and its preview) failed on companies_phone_uq.
describe('CSV import: company-phone-only rows (#76)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())

  it('attaches phone-only rows to the company with that phone, and one bad row never fails the import', async () => {
    db = await createTestDb()
    const { rows: ex } = await db.query<{ id: number }>(
      `insert into lp.companies (name, phone, phone_e164, segment, created_by) values ('Existing Jeweler', '(410) 555-0100', '+14105550100', 'other', 'owner') returning id`,
    )
    const existingId = Number(ex[0].id)
    const mapping = { email: 'email', store_phone: 'company_phone', last: 'last_name' }
    const rows = [
      { email: 'a@one.test', store_phone: '(410) 555-0100', last: 'A' }, // matches the existing company
      { email: 'b@two.test', store_phone: '410-555-0199', last: 'B' }, // new company
      { email: 'c@two.test', store_phone: '410.555.0199', last: 'C' }, // same store phone as row 2, same file
    ]

    const preview = await runCsvImport(db, rows, { mapping, actor: 'owner', dryRun: true })
    expect(preview.would_create).toBe(3)
    expect(preview.invalid).toBe(0)

    const real = await runCsvImport(db, rows, { mapping, actor: 'owner', dryRun: false })
    expect(real.would_create).toBe(3)
    const byEmail = new Map(real.rows.map((r) => [r.email, r.company_id]))
    expect(Number(byEmail.get('a@one.test'))).toBe(existingId)
    expect(byEmail.get('b@two.test')).toBe(byEmail.get('c@two.test'))
    const { rows: cnt } = await db.query<{ n: number }>(`select count(*)::int as n from lp.companies where phone_e164 = '+14105550199'`)
    expect(Number(cnt[0].n)).toBe(1)

    // Safety net: any row that still hits a unique key is skipped and reported, the rest import.
    await db.query(`create unique index test_clash_uq on lp.contacts (last_name) where last_name = 'Clash'`)
    const clash = await runCsvImport(
      db,
      [
        { email: 'd@three.test', store_phone: '', last: 'Clash' },
        { email: 'e@three.test', store_phone: '', last: 'Clash' },
        { email: 'f@three.test', store_phone: '', last: 'Fine' },
      ].map((r) => ({ ...r, store_phone: '410-555-0300' })),
      { mapping, actor: 'owner', dryRun: false },
    )
    expect(clash.would_create).toBe(2)
    expect(clash.invalid).toBe(1)
    const bad = clash.rows.find((r) => r.outcome === 'invalid')!
    expect(bad.email).toBe('e@three.test')
    expect(bad.reason).toMatch(/Row skipped/)
    const { rows: f } = await db.query(`select 1 from lp.contacts where email_norm = 'f@three.test'`)
    expect(f.length).toBe(1)
  })
})
