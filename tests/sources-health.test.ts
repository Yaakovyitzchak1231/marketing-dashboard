import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { sourcesHealth } from '@/lib/sources/health'
import { createTestDb } from './helpers/pglite-db'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
let db: TestDb

beforeAll(async () => {
  db = await createTestDb()
})
afterAll(async () => {
  await db.close()
})

function byId(rows: Awaited<ReturnType<typeof sourcesHealth>>, id: string) {
  return rows.find((r) => r.id === id)
}

describe('sourcesHealth', () => {
  it('reports honest nulls for every source on a fresh database', async () => {
    const rows = await sourcesHealth(db)
    const ids = rows.map((r) => r.id)
    expect(ids).toEqual(
      expect.arrayContaining(['instantly_webhook', 'instantly_api', 'verifiers', 'find_leads_engine', 'imports', 'exports', 'search_console', 'runner_heartbeat']),
    )
    for (const row of rows) {
      expect(row.last_event_at).toBeNull()
      expect(row.count_24h).toBeNull()
    }
  })

  it('counts real rows once they exist, by type, in the last 24h only', async () => {
    const co = await db.query<{ id: number }>("insert into lp.companies (name, website_domain, stage) values ('Acme', 'acme.example', 'in_campaign') returning id")
    const companyId = co.rows[0].id
    const c = await db.query<{ id: number }>(
      "insert into lp.contacts (company_id, email, email_norm, status, verification_status) values ($1, 'a@acme.example', 'a@acme.example', 'in-Instantly', 'valid') returning id",
      [companyId],
    )
    const contactId = c.rows[0].id
    await db.query(
      "insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, source, dedupe_key) values (now(), 'email_sent', $1, $2, 'a@acme.example', 'instantly_webhook', 'h1')",
      [companyId, contactId],
    )
    await db.query(
      "insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, source, dedupe_key) values (now(), 'email_opened', $1, $2, 'a@acme.example', 'instantly_webhook', 'h2')",
      [companyId, contactId],
    )
    // Outside the 24h window: must not count toward count_24h.
    await db.query(
      "insert into lp.lead_events (occurred_at, type, company_id, contact_id, email_norm, source, dedupe_key) values (now() - interval '3 days', 'email_sent', $1, $2, 'a@acme.example', 'instantly_webhook', 'h3')",
      [companyId, contactId],
    )
    await db.query("insert into lp.sources (company_id, contact_id, kind, source_ref) values ($1, $2, 'sheet_import', 'row-1')", [companyId, contactId])
    await db.query(
      "insert into lp.exports (kind, target, destination, row_count, status, finished_at) values ('lead_master_copy', 'csv', '/tmp/x.csv', 10, 'done', now())",
    )

    const rows = await sourcesHealth(db)
    const webhook = byId(rows, 'instantly_webhook')!
    expect(webhook.count_24h).toBe(2)
    expect(webhook.by_type_24h).toEqual({ email_sent: 1, email_opened: 1 })
    expect(webhook.last_event_at).not.toBeNull()

    const imports = byId(rows, 'imports')!
    expect(imports.count_24h).toBe(1)
    expect(imports.by_type_24h).toEqual({ sheet_import: 1 })

    const exportsRow = byId(rows, 'exports')!
    expect(exportsRow.count_24h).toBe(1)
    expect(exportsRow.error_count_24h).toBe(0)
  })

  it('counts a failed job run as an error and surfaces the error message', async () => {
    await db.query(
      "insert into lp.jobs (name, kind, schedule_cron) values ('instantly_reconcile', 'instantly_reconcile', '0 7 * * *') on conflict (name) do nothing",
    )
    await db.query(
      "insert into lp.job_runs (job_name, status, started_at, finished_at, error) values ('instantly_reconcile', 'failed', now(), now(), 'Instantly rejected the API key')",
    )
    const rows = await sourcesHealth(db)
    const reconcile = byId(rows, 'instantly_api')!
    expect(reconcile.count_24h).toBe(1)
    expect(reconcile.error_count_24h).toBe(1)
    expect(reconcile.last_error).toBe('Instantly rejected the API key')
  })

  it('the 1.6 migration seeded the instantly_reconcile job row', async () => {
    const { rows } = await db.query<{ kind: string; enabled: boolean }>("select kind, enabled from lp.jobs where name = 'instantly_reconcile'")
    expect(rows[0]).toMatchObject({ kind: 'instantly_reconcile', enabled: true })
  })
})
