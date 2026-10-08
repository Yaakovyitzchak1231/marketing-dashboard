import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { generateKeyPairSync, createVerify } from 'node:crypto'
import { EXPORT_COLUMNS, csvField, exportCsv, exportRows, finishExport, recentExports, startExport } from '@/lib/export/lead-master'
import { assertExportTab, serviceAccountToken, writeExportTab, sheetExportConfigured, DEFAULT_EXPORT_TAB } from '@/lib/export/sheets'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'

describe('CSV fields', () => {
  it('quotes and defuses spreadsheet formulas', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('say "hi"')).toBe('"say ""hi"""')
    expect(csvField('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvField('+1 410')).toBe("'+1 410")
  })
})

describe('Lead Master copy from the database', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
    const a = await addCompany(db, { name: 'Gem, Co', state: 'MD', city: 'Baltimore', domain: 'gem.com' })
    const ca = await addContact(db, a, 'Owner@Gem.com', 'valid')
    await addTouch(db, { companyId: a, contactId: ca, campaign: 'Seg 3', event: 'email_sent', at: '2026-10-01T10:00:00Z' })
    await addTouch(db, { companyId: a, contactId: ca, campaign: 'Seg 3', event: 'reply_received', at: '2026-10-03T10:00:00Z' })
    const b = await addCompany(db, { name: 'No Email Co' })
    await db.query('insert into lp.contacts (company_id, first_name) values ($1, $2)', [b, 'Nobody'])
    for (let i = 0; i < 7; i++) {
      const c = await addCompany(db, { name: `Bulk ${i}` })
      await addContact(db, c, `x${i}@bulk${i}.com`, 'unverified')
    }
  })
  afterAll(async () => {
    await db.close()
  })

  it('writes one row per contact with an email, latest touch, stable order, in pages', async () => {
    const pages: number[] = []
    const all = []
    for await (const p of exportRows(db, 3)) {
      pages.push(p.length)
      all.push(...p)
    }
    expect(pages).toEqual([3, 3, 2])
    expect(all).toHaveLength(8)
    const gem = all.find((r) => r.company === 'Gem, Co')!
    expect(gem.email).toBe('Owner@Gem.com')
    expect(gem.last_event).toBe('reply_received')
    expect(gem.last_campaign).toBe('Seg 3')
    expect(gem.verification_status).toBe('valid')
    expect(gem.do_not_contact).toBe('no')
    expect(all.map((r) => Number(r.contact_id))).toEqual([...all.map((r) => Number(r.contact_id))].sort((x, y) => x - y))
  })

  it('CSV has the header and is identical when run twice (idempotent)', async () => {
    const one = await exportCsv(db)
    const two = await exportCsv(db)
    expect(one.rows).toBe(8)
    expect(one.csv.split('\r\n')[0]).toBe(EXPORT_COLUMNS.join(','))
    expect(one.csv).toContain('"Gem, Co"')
    expect(two.csv).toBe(one.csv)
  })

  it('logs each run', async () => {
    const id = await startExport(db, 'owner', 'csv', 'download')
    await finishExport(db, id, 8, null)
    const id2 = await startExport(db, 'system', 'sheet', 'sheet / tab')
    await finishExport(db, id2, null, 'Google said no')
    const runs = await recentExports(db)
    expect(runs[0]).toMatchObject({ target: 'sheet', status: 'failed', error: 'Google said no' })
    expect(runs[1]).toMatchObject({ target: 'csv', status: 'done', row_count: 8 })
  })

  it('never writes a tab that is not a "DB export" tab', () => {
    expect(() => assertExportTab('Leads')).toThrow(/Refusing/)
    expect(() => assertExportTab('600 with item')).toThrow(/Refusing/)
    expect(() => assertExportTab("DB export'!A1")).toThrow()
    expect(assertExportTab(DEFAULT_EXPORT_TAB)).toBe('DB export (read-only)')
  })

  it('creates the export tab if missing, clears it, writes every row; touches nothing else', async () => {
    const calls: { url: string; method: string; body: unknown }[] = []
    const fake: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url.includes('fields=sheets')) return new Response(JSON.stringify({ sheets: [{ properties: { title: 'Leads' } }] }), { status: 200 })
      return new Response('{}', { status: 200 })
    }
    const r = await writeExportTab(db, { sheetId: '1_alVi83quQCuVTpkBK6MJQ850Gw1K7nGeomjSHXtiiI', token: 't', fetchImpl: fake })
    expect(r).toMatchObject({ rows: 8, created: true, tab: 'DB export (read-only)' })
    expect(calls[1].body).toEqual({ requests: [{ addSheet: { properties: { title: 'DB export (read-only)' } } }] })
    const valueCalls = calls.filter((c) => c.url.includes('/values/'))
    expect(valueCalls.length).toBeGreaterThanOrEqual(3)
    for (const c of valueCalls) expect(decodeURIComponent(c.url)).toContain("'DB export (read-only)'!")
    expect(calls.some((c) => decodeURIComponent(c.url).includes("'Leads'"))).toBe(false)
    expect(valueCalls[0].url).toMatch(/:clear$/)
    const written = valueCalls.slice(1).flatMap((c) => (c.body as { values: string[][] }).values)
    expect(written[0]).toEqual([...EXPORT_COLUMNS])
    expect(written).toHaveLength(9)

    // second run: tab exists, so no addSheet
    calls.length = 0
    const fake2: typeof fetch = async (input, init) => {
      const url = String(input)
      calls.push({ url, method: init?.method ?? 'GET', body: null })
      if (url.includes('fields=sheets')) return new Response(JSON.stringify({ sheets: [{ properties: { title: 'Leads' } }, { properties: { title: 'DB export (read-only)' } }] }), { status: 200 })
      return new Response('{}', { status: 200 })
    }
    const r2 = await writeExportTab(db, { sheetId: '1_alVi83quQCuVTpkBK6MJQ850Gw1K7nGeomjSHXtiiI', token: 't', fetchImpl: fake2 })
    expect(r2.created).toBe(false)
    expect(calls.some((c) => c.url.includes(':batchUpdate'))).toBe(false)
  })

  it('reports a Google refusal in plain words', async () => {
    const fake: typeof fetch = async () => new Response(JSON.stringify({ error: { message: 'The caller does not have permission' } }), { status: 403 })
    await expect(writeExportTab(db, { sheetId: '1_alVi83quQCuVTpkBK6MJQ850Gw1K7nGeomjSHXtiiI', token: 't', fetchImpl: fake })).rejects.toThrow(/does not have permission/)
  })
})

describe('service account token', () => {
  it('signs an RS256 JWT for the Sheets scope and trades it for a token', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    let assertion = ''
    const fake: typeof fetch = async (_url, init) => {
      assertion = new URLSearchParams(String(init?.body)).get('assertion') ?? ''
      return new Response(JSON.stringify({ access_token: 'ya29.test' }), { status: 200 })
    }
    const tok = await serviceAccountToken(JSON.stringify({ client_email: 'export@proj.iam.gserviceaccount.com', private_key: pem }), fake, 1_800_000_000)
    expect(tok).toBe('ya29.test')
    const [h, c, s] = assertion.split('.')
    const claim = JSON.parse(Buffer.from(c, 'base64url').toString())
    expect(claim).toMatchObject({ iss: 'export@proj.iam.gserviceaccount.com', scope: 'https://www.googleapis.com/auth/spreadsheets', exp: 1_800_003_600 })
    const v = createVerify('RSA-SHA256')
    v.update(`${h}.${c}`)
    expect(v.verify(publicKey, new Uint8Array(Buffer.from(s, 'base64url')))).toBe(true)
  })

  it('knows when the Sheet export is configured', () => {
    expect(sheetExportConfigured({})).toBe(false)
    expect(sheetExportConfigured({ LEAD_MASTER_SHEET_ID: 'x' })).toBe(false)
    expect(sheetExportConfigured({ LEAD_MASTER_SHEET_ID: 'x', GOOGLE_SERVICE_ACCOUNT_JSON: '{}' })).toBe(true)
  })
})
