import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'
import { csvObjects, parseCsv } from '@/lib/leads/csv'
import { importLeadRows, parseSheetDate } from '@/lib/leads/import'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb
const rows = csvObjects(readFileSync(join(__dirname, 'fixtures', 'lead_master_sample.csv'), 'utf8'))

beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

describe('CSV parsing', () => {
  it('handles quotes, commas and newlines inside fields', () => {
    expect(parseCsv('a,b\n"x, y","say ""hi""\nthere"\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"\nthere']])
    expect(rows).toHaveLength(7)
    expect(rows[2].company_name).toBe('Old Town Jewelry, LLC')
  })
  it('reads the Sheet dates (no year) as Eastern time', () => {
    expect(parseSheetDate('Oct 5, 3:51 PM', 2026)?.toISOString()).toBe('2026-10-05T19:51:00.000Z')
    expect(parseSheetDate('', 2026)).toBeNull()
  })
})

describe('Lead Master import', () => {
  it('dedupes companies by domain and phone, contacts by email, and skips rows without a valid email', async () => {
    const s = await importLeadRows(db, rows, { year: 2026 })
    expect(s).toMatchObject({ rows: 7, skipped_no_email: 1, skipped_bad_email: 1, contacts_created: 5 })
    // Bright Gems twice (same domain) -> 1 company; Ring House twice (same phone) -> 1 company; Old Town -> 1.
    expect(s.companies_created).toBe(3)
    const co = await db.query<{ name: string; stage: string; research_status: string }>('select name, stage, research_status from lp.companies order by id')
    expect(co.rows.map((r) => r.name)).toEqual(['Bright Gems', 'Old Town Jewelry, LLC', 'Ring House'])
    expect(co.rows[0]).toMatchObject({ stage: 'ready', research_status: 'researched' })
    expect(co.rows[1].stage).toBe('in_campaign')
  })

  it('carries MillionVerifier results, campaign touches, sources and enrichment with evidence', async () => {
    const v = await db.query<{ email: string; verdict: string; provider: string }>('select email, verdict, provider from lp.verification_results order by id')
    expect(v.rows).toEqual([
      { email: 'maria@brightgems.example', verdict: 'valid', provider: 'sheet_import' },
      { email: 'info@brightgems.example', verdict: 'catch_all', provider: 'sheet_import' },
      { email: 'sam@oldtown.example', verdict: 'valid', provider: 'sheet_import' },
      { email: 'lee@ringhouse-nyc.example', verdict: 'valid', provider: 'sheet_import' },
    ])
    const c = await db.query<{ verification_status: string; is_role_address: boolean }>("select verification_status, is_role_address from lp.contacts where email_norm = 'info@brightgems.example'")
    expect(c.rows[0]).toEqual({ verification_status: 'catch_all', is_role_address: true })
    const t = await db.query<{ campaign_name: string }>('select campaign_name from lp.campaign_touches')
    expect(t.rows).toEqual([{ campaign_name: 'A Fees' }])
    const e = await db.query<{ value: string; evidence_url: string | null; confidence: string | null }>("select value, evidence_url, confidence from lp.enrichment where field = 'owner_first_name' and value = 'Maria'")
    expect(e.rows[0]).toEqual({ value: 'Maria', evidence_url: 'https://www.brightgems.example/about', confidence: 'high' })
  })

  it('is idempotent: a second run adds nothing and changes no status', async () => {
    await db.query("update lp.contacts set status = 'replied' where email_norm = 'sam@oldtown.example'")
    const before = await db.query<{ n: number }>('select (select count(*) from lp.companies) + (select count(*) from lp.contacts) + (select count(*) from lp.verification_results) + (select count(*) from lp.campaign_touches) + (select count(*) from lp.enrichment) + (select count(*) from lp.sources) as n')
    const s = await importLeadRows(db, rows, { year: 2026 })
    expect(s).toMatchObject({ companies_created: 0, contacts_created: 0, contacts_existing: 5, verifications_added: 0, touches_added: 0, enrichment_added: 0 })
    const after = await db.query<{ n: number }>('select (select count(*) from lp.companies) + (select count(*) from lp.contacts) + (select count(*) from lp.verification_results) + (select count(*) from lp.campaign_touches) + (select count(*) from lp.enrichment) + (select count(*) from lp.sources) as n')
    expect(after.rows[0].n).toBe(before.rows[0].n)
    const sam = await db.query<{ status: string }>("select status from lp.contacts where email_norm = 'sam@oldtown.example'")
    expect(sam.rows[0].status).toBe('replied')
  })
})
