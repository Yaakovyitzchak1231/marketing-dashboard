import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readdirSync, copyFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { applyMigrations, migrationFiles } from '@/scripts/lib/migrate.mjs'
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { nextRun } from '@/lib/jobs/cron'
import { handle as opsCallHandle } from '@/runner/handlers/ops_call.mjs'

/**
 * Plan 2.12: the daily segment_snapshot job.
 *
 * 0033_traits.sql seeded lp.jobs 'segment_snapshot' (America/New_York, payload
 * without args). 0058 normalises it to UTC -- but only while the row is still
 * 0033's original seed, so an operator's edits are never overwritten.
 *
 * Migrations are applied the way the real migrator applies them
 * (scripts/lib/migrate.mjs applyMigrations: filename order, one transaction each,
 * recorded in lp_schema_migrations), in two stages so an operator edit can land
 * between 0033 and 0058.
 */
const REAL = join(__dirname, '..', 'db', 'migrations')
const MIGRATION_0058 = '0058_normalize_segment_snapshot_job.sql'

/** node-postgres-shaped client over PGlite (same shape as tests/db-migrate.test.ts). */
function client(pg: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params && params.length) return pg.query(text, params)
      const all = await pg.exec(text)
      return all[all.length - 1] ?? { rows: [] }
    },
  }
}

const JOB_SQL = `select name, kind, description, schedule_cron, timezone, campaign_id, payload, enabled, timeout_s,
                        next_run_at, last_run_at, last_status, created_by, updated_at
                   from lp.jobs where name = 'segment_snapshot'`

type JobRow = {
  name: string
  kind: string
  description: string | null
  schedule_cron: string | null
  timezone: string
  campaign_id: number | null
  payload: Record<string, unknown>
  enabled: boolean
  timeout_s: number
  next_run_at: Date | null
  last_run_at: Date | null
  last_status: string | null
  created_by: string | null
  updated_at: Date
}

const open: PGlite[] = []
afterEach(async () => {
  while (open.length) await open.pop()!.close()
})

/** Migrations strictly before 0058 applied; the rest are staged for `finish()`. */
async function dbBefore0058() {
  const dir = mkdtempSync(join(tmpdir(), 'mig-0058-'))
  const all = migrationFiles(REAL)
  expect(all).toContain(MIGRATION_0058)
  const stage = (files: string[]) => files.forEach((f) => copyFileSync(join(REAL, f), join(dir, f)))
  const before = all.filter((f) => f < MIGRATION_0058)
  const rest = all.filter((f) => f >= MIGRATION_0058)
  stage(before)
  const pg = new PGlite()
  open.push(pg)
  const first = await applyMigrations(client(pg), { dir })
  expect(first.failed).toBeNull()
  const job = async () => (await pg.query<JobRow>(JOB_SQL)).rows
  return {
    pg,
    job,
    /** Apply 0058 and everything after it, exactly as the migrator would. */
    async finish() {
      stage(rest)
      const r = await applyMigrations(client(pg), { dir })
      expect(r.failed).toBeNull()
      expect(r.applied).toContain(MIGRATION_0058)
      return r
    },
  }
}

describe('segment_snapshot scheduled job (migrations 0033 then 0058)', () => {
  it('0033 alone leaves the America/New_York row that 0058 exists to normalise', async () => {
    const { job } = await dbBefore0058()
    const [j] = await job()
    expect(j.timezone).toBe('America/New_York')
    expect(j.payload).toEqual({ op: 'segment_snapshot' })
    expect(j.next_run_at).toBeNull() // the runner only claims rows with a next_run_at
  })

  it('after every migration: one enabled ops_call job, daily 07:00 UTC, payload {op, args:{}}, timeout 600', async () => {
    const t = await dbBefore0058()
    const before = new Date()
    await t.finish()
    const after = new Date()
    const rows = await t.job()
    expect(rows).toHaveLength(1)
    const j = rows[0]
    expect(j.kind).toBe('ops_call')
    expect(j.schedule_cron).toBe('0 7 * * *')
    expect(j.timezone).toBe('UTC')
    expect(j.enabled).toBe(true)
    expect(j.timeout_s).toBe(600)
    expect(j.campaign_id).toBeNull()
    expect(j.payload).toEqual({ op: 'segment_snapshot', args: {} })
    expect(j.created_by).toBe('system') // 0033's seed owner is kept
    // The runner only claims rows whose next_run_at is set; it must be the next 07:00 UTC.
    const candidates = [before, after].map((d) => nextRun('0 7 * * *', d, 'UTC').toISOString())
    expect(candidates).toContain(j.next_run_at!.toISOString())
    expect(j.next_run_at!.getUTCHours()).toBe(7)
    expect(j.next_run_at!.getTime()).toBeGreaterThan(before.getTime())
    // never run, so nothing about run history was invented
    expect(j.last_run_at).toBeNull()
    expect(j.last_status).toBeNull()
  })

  it('the final schedule parses to a daily 07:00 UTC run (not local time)', async () => {
    const t = await dbBefore0058()
    await t.finish()
    const [j] = await t.job()
    const r = nextRun(j.schedule_cron!, new Date('2026-06-01T12:00:00Z'), j.timezone)
    expect(r.toISOString()).toBe('2026-06-02T07:00:00.000Z')
  })

  it('is idempotent: running 0058 again changes nothing', async () => {
    const t = await dbBefore0058()
    await t.finish()
    const once = await t.job()
    // The migrator would skip an applied file, so run the SQL itself a second time.
    await t.pg.exec(readFileSync(join(REAL, MIGRATION_0058), 'utf8'))
    const twice = await t.job()
    expect(twice).toEqual(once) // incl. next_run_at and updated_at: no UPDATE happened
    expect(twice).toHaveLength(1)
    // and the real migrator reports it as already applied
    const again = await applyMigrations(client(t.pg), { dir: REAL })
    expect(again.applied).toEqual([])
  })

  it.each([
    ['a different time', `schedule_cron = '30 6 * * *'`],
    ['paused (disabled)', `enabled = false`],
    ['another timezone', `timezone = 'Europe/London'`],
    ['a longer timeout', `timeout_s = 1800`],
    ['an edited payload', `payload = '{"op":"segment_snapshot","args":{"note":"x"}}'::jsonb`],
    ['an edited description', `description = 'Operator wording'`],
    ['pinned to a campaign', `campaign_id = (select id from lp.campaigns limit 1)`],
  ])('leaves an operator-edited row alone: %s', async (_label, setClause) => {
    const t = await dbBefore0058()
    if (setClause.includes('lp.campaigns')) {
      await t.pg.exec(`insert into lp.campaigns (name) values ('c1')`)
    }
    await t.pg.exec(`update lp.jobs set ${setClause} where name = 'segment_snapshot'`)
    const edited = await t.job()
    await t.finish()
    expect(await t.job()).toEqual(edited) // every column, incl. updated_at and next_run_at, untouched
  })

  it('a single changed field counts as an edit: the rest of the row is not normalised either', async () => {
    const t = await dbBefore0058()
    // Only the timeout differs from the seed; timezone is still America/New_York.
    await t.pg.exec(`update lp.jobs set timeout_s = 120 where name = 'segment_snapshot'`)
    await t.finish()
    const [j] = await t.job()
    expect(j.timezone).toBe('America/New_York')
    expect(j.payload).toEqual({ op: 'segment_snapshot' })
    expect(j.timeout_s).toBe(120)
  })

  it('re-creates the job when it was deleted beforehand (lp.jobs has no soft delete)', async () => {
    const t = await dbBefore0058()
    await t.pg.exec(`delete from lp.jobs where name = 'segment_snapshot'`)
    expect(await t.job()).toHaveLength(0)
    await t.finish()
    const rows = await t.job()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: 'ops_call',
      schedule_cron: '0 7 * * *',
      timezone: 'UTC',
      enabled: true,
      timeout_s: 600,
      payload: { op: 'segment_snapshot', args: {} },
    })
    expect(rows[0].next_run_at).not.toBeNull()
    // and the owner can delete it afterwards without a second 0058 run bringing it back
    await t.pg.exec(`delete from lp.jobs where name = 'segment_snapshot'`)
    const again = await applyMigrations(client(t.pg), { dir: REAL })
    expect(again.applied).toEqual([])
    expect(await t.job()).toHaveLength(0)
  })
})

describe('segment_snapshot job payload and op', () => {
  it('the runner treats a payload without args and one with args:{} identically (runner/handlers/ops_call.mjs:12)', async () => {
    const calls: { op: string; args: unknown }[] = []
    const run = (payload: Record<string, unknown>) =>
      opsCallHandle({
        payload,
        ops: async (op: string, args: unknown) => {
          calls.push({ op, args })
          return { ok: true }
        },
        log: () => {},
      })
    const a = await run({ op: 'segment_snapshot' })
    const b = await run({ op: 'segment_snapshot', args: {} })
    expect(a).toEqual(b)
    expect(calls).toEqual([
      { op: 'segment_snapshot', args: {} },
      { op: 'segment_snapshot', args: {} },
    ])
  })

  it('the runner can execute the op the payload names, as the system actor', async () => {
    // Mirrors what runner/handlers/ops_call.mjs does: call /api/ops with the
    // job's payload. segment_snapshot is idempotent and safe for a db with no
    // segments, so it must complete and report a segments count (0 here).
    const db = await createTestDb()
    try {
      const result = (await runOp(db, 'system', 'segment_snapshot', {})) as {
        segments: number
        results: { segment_id: number; written: boolean }[]
        alerts: { checked: number; alerted: number }
      }
      expect(result.segments).toBe(0)
      expect(result.results).toEqual([])
      expect(result.alerts).toEqual({ checked: 0, alerted: 0 })
    } finally {
      await db.close()
    }
  })

  it('every migration file is listed in order with 0058 present and its number unique', () => {
    const files = readdirSync(REAL).filter((f) => f.endsWith('.sql'))
    expect(files.filter((f) => f.startsWith('0058_'))).toEqual([MIGRATION_0058])
  })
})
