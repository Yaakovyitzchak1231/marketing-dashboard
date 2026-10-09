import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createTestDb } from './helpers/pglite-db'

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))

import { POST } from '@/app/api/ops/import/lead-master/route'
import { importLeadRows, sheetStatus } from '@/lib/leads/import'
import { csvObjects } from '@/lib/leads/csv'

const TOKEN = 'tab-token-0123456789abcdefghijkl'
const CSV = readFileSync(join(__dirname, 'fixtures', 'lead_master_sample.csv'), 'utf8')
const URL_BASE = 'https://app.test/api/ops/import/lead-master'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

function post(rows: Record<string, string>[], query: string, token: string | null = TOKEN) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return POST(new Request(`${URL_BASE}${query}`, { method: 'POST', headers, body: JSON.stringify({ rows }) }))
}

async function statusOf(email: string) {
  const r = await db.query<{ status: string; do_not_contact: boolean }>('select status, do_not_contact from lp.contacts where email_norm = $1', [email])
  return r.rows[0]
}

/** The sample rows with some statuses changed, as the Sheet looks after people worked in it. */
function edited(): Record<string, string>[] {
  return csvObjects(CSV).map((r) => {
    if (r.email === 'maria@brightgems.example') return { ...r, status: 'in-Instantly' }
    if (r.email === 'info@brightgems.example') return { ...r, status: 'role-based-hold' }
    if (r.email === 'hello@ringhouse.example') return { ...r, status: 'needs check' }
    if (r.email === 'lee@ringhouse-nyc.example') return { ...r, status: 'parked-somewhere' }
    return r
  })
}

beforeEach(async () => {
  db = await createTestDb()
  holder.db = db
  vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
  await importLeadRows(db, csvObjects(CSV), { actor: 'tab' })
})
afterEach(async () => {
  holder.db = null
  await db.close()
})

describe('sheetStatus', () => {
  it('accepts the Sheet vocabulary, including the newer hold statuses', () => {
    expect(sheetStatus('in-Instantly')).toBe('in-Instantly')
    expect(sheetStatus('in-instantly')).toBe('in-Instantly')
    expect(sheetStatus('role-based-hold')).toBe('role-based-hold')
    expect(sheetStatus('needs check')).toBe('needs-check')
    expect(sheetStatus(' ')).toBeNull()
    expect(sheetStatus('parked-somewhere')).toBeNull()
  })
})

describe('POST /api/ops/import/lead-master?mode=sync_status', () => {
  it('needs a token, and rejects an unknown mode', async () => {
    expect((await post(edited(), '?mode=sync_status', null)).status).toBe(401)
    const r = await post(edited(), '?mode=overwrite_everything')
    expect(r.status).toBe(400)
    expect((await r.json()).error).toMatch(/Unknown mode/)
  })

  it('dry run counts the changes and writes nothing', async () => {
    const j = await (await post(edited(), '?mode=sync_status&dry_run=1')).json()
    expect(j).toMatchObject({ ok: true, mode: 'sync_status', dry_run: true, actor: 'tab' })
    expect(j.stats).toMatchObject({ rows: 7, changed: 3, unchanged: 1, unknown_status: 1, not_in_database: 0, skipped_no_email: 2 })
    expect(j.stats.transitions).toEqual({
      'valid-ready -> in-Instantly': 1,
      'catch-all-hold -> role-based-hold': 1,
      'guessed-hold -> needs-check': 1,
    })
    expect(j.stats.unknown_statuses).toEqual({ 'parked-somewhere': 1 })
    expect((await statusOf('maria@brightgems.example')).status).toBe('valid-ready')
    const ev = await db.query("select count(*)::int as n from lp.events where kind = 'import.status_sync'")
    expect(ev.rows[0].n).toBe(0)
  })

  it('writes the Sheet status only where it differs, logs who did it, and is idempotent', async () => {
    const j = await (await post(edited(), '?mode=sync_status&label=test')).json()
    expect(j.stats.changed).toBe(3)
    expect((await statusOf('maria@brightgems.example')).status).toBe('in-Instantly')
    expect((await statusOf('info@brightgems.example')).status).toBe('role-based-hold')
    expect((await statusOf('hello@ringhouse.example')).status).toBe('needs-check')
    // unknown Sheet status: the database keeps its own
    expect((await statusOf('lee@ringhouse-nyc.example')).status).toBe('valid-ready')
    // untouched row
    expect((await statusOf('sam@oldtown.example')).status).toBe('in-Instantly')

    const hist = await db.query<{ old_value: string; new_value: string; changed_by: string }>(
      `select h.old_value, h.new_value, h.changed_by from lp.status_history h join lp.contacts c on c.id = h.entity_id
        where h.entity_type = 'contact' and h.field = 'status' and c.email_norm = 'maria@brightgems.example' order by h.id`,
    )
    expect(hist.rows.at(-1)).toEqual({ old_value: 'valid-ready', new_value: 'in-Instantly', changed_by: 'tab' })

    const ev = await db.query<{ actor: string; summary: string; data: { changes: unknown[] } }>(
      "select actor, summary, data from lp.events where kind = 'import.status_sync'",
    )
    expect(ev.rows).toHaveLength(1)
    expect(ev.rows[0].actor).toBe('tab')
    expect(ev.rows[0].summary).toMatch(/3 changed/)
    expect(ev.rows[0].data.changes).toHaveLength(3)

    const again = await (await post(edited(), '?mode=sync_status')).json()
    expect(again.stats).toMatchObject({ changed: 0, unchanged: 4 })
    const ev2 = await db.query("select count(*)::int as n from lp.events where kind = 'import.status_sync'")
    expect(ev2.rows[0].n).toBe(1)
  })

  it('never creates contacts, and do-not-contact also sets the flag', async () => {
    const rows = [
      { email: 'maria@brightgems.example', status: 'do-not-contact' },
      { email: 'stranger@nowhere.example', status: 'valid-ready' },
    ]
    const j = await (await post(rows, '?mode=sync_status')).json()
    expect(j.stats).toMatchObject({ changed: 1, not_in_database: 1 })
    expect(await statusOf('maria@brightgems.example')).toEqual({ status: 'do-not-contact', do_not_contact: true })
    expect(await statusOf('stranger@nowhere.example')).toBeUndefined()
  })

  it('the normal import gives new contacts the newer statuses too', async () => {
    await importLeadRows(db, [{ email: 'owner@newstore.example', status: 'role-based-hold', company_name: 'New Store', website: 'https://newstore.example' }], { actor: 'tab' })
    expect((await statusOf('owner@newstore.example')).status).toBe('role-based-hold')
  })
})
