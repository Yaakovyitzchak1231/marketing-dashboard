import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { createTestDb } from './helpers/pglite-db'
import { csvObjects } from '@/lib/leads/csv'

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))

import { GET, POST } from '@/app/api/ops/import/lead-master/route'
import { MAX_ROWS_PER_REQUEST, parseImportBody } from '@/lib/leads/import-request'

const TOKEN = 'tab-token-0123456789abcdefghijkl'
const CSV = readFileSync(join(__dirname, 'fixtures', 'lead_master_sample.csv'), 'utf8')
const URL_BASE = 'https://app.test/api/ops/import/lead-master'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

function post(body: BodyInit, opts: { query?: string; type?: string; token?: string | null } = {}) {
  const headers: Record<string, string> = { 'Content-Type': opts.type ?? 'text/csv' }
  if (opts.token !== null) headers.Authorization = `Bearer ${opts.token ?? TOKEN}`
  return POST(new Request(`${URL_BASE}${opts.query ?? ''}`, { method: 'POST', headers, body }))
}

async function counts() {
  const r = await db.query<{ contacts: number; companies: number; events: number }>(
    "select (select count(*) from lp.contacts)::int as contacts, (select count(*) from lp.companies)::int as companies, (select count(*) from lp.events where kind = 'import.lead_master')::int as events",
  )
  return r.rows[0]
}

beforeEach(async () => {
  db = await createTestDb()
  holder.db = db
  vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
})
afterEach(async () => {
  holder.db = null
  await db.close()
})

describe('POST /api/ops/import/lead-master', () => {
  it('rejects a missing or wrong token, and says so when the database is not connected', async () => {
    expect((await post(CSV, { token: null })).status).toBe(401)
    expect((await post(CSV, { token: 'not-the-token-0123456789abcdef' })).status).toBe(401)
    holder.db = null
    const r = await post(CSV)
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/DATABASE_URL/)
  })

  it('dry run returns the real counts and writes nothing', async () => {
    const r = await post(CSV, { query: '?dry_run=1' })
    expect(r.status).toBe(200)
    const j = await r.json()
    expect(j).toMatchObject({ ok: true, dry_run: true, actor: 'tab' })
    expect(j.stats).toMatchObject({ rows: 7, contacts_created: 5, companies_created: 3, skipped_no_email: 1, skipped_bad_email: 1 })
    expect(await counts()).toEqual({ contacts: 0, companies: 0, events: 0 })
  })

  it('imports a CSV, and re-sending it duplicates nothing', async () => {
    const first = await (await post(CSV)).json()
    expect(first.stats).toMatchObject({ contacts_created: 5, companies_created: 3 })
    expect(await counts()).toEqual({ contacts: 5, companies: 3, events: 1 })
    const again = await (await post(CSV)).json()
    expect(again.stats).toMatchObject({ contacts_created: 0, companies_created: 0, contacts_existing: 5 })
    expect(await counts()).toMatchObject({ contacts: 5, companies: 3 })
  })

  it('takes gzip-compressed JSON rows in chunks, same result as one CSV', async () => {
    const rows = csvObjects(CSV)
    for (const part of [rows.slice(0, 3), rows.slice(3)]) {
      const r = await post(new Uint8Array(gzipSync(new TextEncoder().encode(JSON.stringify({ rows: part })))), { type: 'application/gzip' })
      expect(r.status).toBe(200)
    }
    expect(await counts()).toMatchObject({ contacts: 5, companies: 3, events: 2 })
    const g = await (await GET(new Request(URL_BASE, { headers: { Authorization: `Bearer ${TOKEN}` } }))).json()
    expect(g).toMatchObject({ ok: true, contacts: 5, companies: 3 })
  })

  it('honours "dry_run": true inside a JSON body', async () => {
    const j = await (await post(JSON.stringify({ dry_run: true, rows: csvObjects(CSV) }), { type: 'application/json' })).json()
    expect(j.dry_run).toBe(true)
    expect(await counts()).toMatchObject({ contacts: 0 })
  })

  it('answers bad bodies with a 4xx and a reason', async () => {
    expect((await post('')).status).toBe(400)
    expect((await post('name,phone\nA,1\n')).status).toBe(400)
    expect((await post('{"rows": 3}', { type: 'application/json' })).status).toBe(400)
  })
})

describe('parseImportBody', () => {
  it('caps rows per request so each call fits in the function time limit', () => {
    const big = 'email\n' + Array.from({ length: MAX_ROWS_PER_REQUEST + 1 }, (_, i) => `a${i}@x.com`).join('\n')
    expect(() => parseImportBody(new TextEncoder().encode(big), { contentType: 'text/csv' })).toThrow(/at most/)
  })
  it('lowercases JSON column names like the CSV header', () => {
    const { rows } = parseImportBody(new TextEncoder().encode(JSON.stringify([{ Email: 'A@x.com', Company_Name: 'X' }])), { contentType: 'application/json' })
    expect(rows[0]).toEqual({ email: 'A@x.com', company_name: 'X' })
  })
})
