import { describe, it, expect, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runCsvImport, CsvImportError, companyDomainFromEmail } from '@/lib/leads/csv-import'

// Viktor's re-review of #89 (Oct 11, 3:44 PM) and Yaakov's 3:43 PM decision:
// (a) rows must attach to the SURVIVOR of a company merge, never the merged-away row;
// (b) a bad pool / campaign gives a clear error, not a raw database failure;
// (c) an email-only row matches an existing company by its email domain (free-mail excluded).
describe('CSV import: merged companies, bad pool, email-domain matching', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  afterAll(async () => db?.close())
  const co = async (name: string, domain: string | null) =>
    Number((await db.query<{ id: number }>(`insert into lp.companies (name, website_domain, segment, created_by) values ($1, $2, 'other', 'owner') returning id`, [name, domain])).rows[0].id)
  const companyOf = async (email: string) =>
    Number((await db.query<{ company_id: number }>(`select company_id from lp.contacts where email_norm = $1`, [email])).rows[0].company_id)

  it('(a) attaches to the survivor of a merge, by key and through an existing contact', async () => {
    db = await createTestDb()
    const hidden = await co('Old Shop', 'oldshop.test')
    const survivor = await co('Shop (kept)', 'shop.test')
    await db.query(`insert into lp.contacts (company_id, email, email_norm) values ($1, 'kept@x.test', 'kept@x.test')`, [hidden])
    await db.query(`update lp.companies set merged_into = $2 where id = $1`, [hidden, survivor])

    const r = await runCsvImport(
      db,
      [
        { email: 'new@oldshop.test', website: 'oldshop.test' },
        { email: 'kept@x.test', website: '' },
      ],
      { mapping: { email: 'email', website: 'website' }, actor: 'owner', dryRun: false },
    )
    expect(r.invalid).toBe(0)
    expect(await companyOf('new@oldshop.test')).toBe(survivor)
    expect(r.rows.find((x) => x.email === 'kept@x.test')?.company_id).toBe(survivor)
  })

  it('(b) an unknown pool or campaign is a clear error before anything is written', async () => {
    const rows = [{ email: 'p@pool.test' }]
    await expect(runCsvImport(db, rows, { mapping: { email: 'email' }, pool: 'nope', actor: 'owner', dryRun: true })).rejects.toThrow(CsvImportError)
    await expect(runCsvImport(db, rows, { mapping: { email: 'email' }, pool: 'nope', actor: 'owner', dryRun: true })).rejects.toThrow(/Unknown pool "nope"/)
    await expect(runCsvImport(db, rows, { mapping: { email: 'email' }, campaign_id: 999999, actor: 'owner', dryRun: false })).rejects.toThrow(/No campaign/)
    const ok = await runCsvImport(db, rows, { mapping: { email: 'email' }, pool: 'other', actor: 'owner', dryRun: false })
    expect(ok.would_create).toBe(1)
  })

  it('(c) email-only rows match by email domain; free-mail never does; new domains get one company', async () => {
    expect(companyDomainFromEmail('a@Gmail.com')).toBeNull()
    expect(companyDomainFromEmail('a@acmejewel.test')).toBe('acmejewel.test')
    const acme = await co('Acme Jewel', 'acmejewel.test')
    const r = await runCsvImport(
      db,
      [
        { email: 'sara@acmejewel.test' },
        { email: 'joe@gmail.com' },
        { email: 'kim@newshop.test' },
        { email: 'lee@newshop.test' },
      ],
      { mapping: { email: 'email' }, actor: 'owner', dryRun: false },
    )
    expect(r.would_create).toBe(4)
    expect(await companyOf('sara@acmejewel.test')).toBe(acme)
    const { rows: g } = await db.query<{ name: string; website_domain: string | null }>(`select name, website_domain from lp.companies where id = $1`, [await companyOf('joe@gmail.com')])
    expect(g[0]).toEqual({ name: '(unknown)', website_domain: null })
    expect(await companyOf('kim@newshop.test')).toBe(await companyOf('lee@newshop.test'))
    const { rows: n } = await db.query<{ name: string }>(`select name from lp.companies where website_domain = 'newshop.test'`)
    expect(n).toEqual([{ name: 'newshop.test' }])
  })
})
