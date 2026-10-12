import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

/**
 * 2.12: the daily segment_snapshot job is seeded by migration 0055 with an
 * lp.jobs row of kind 'ops_call' pointing at the 'segment_snapshot' op. The
 * runner (runner/handlers/ops_call.mjs) routes that payload to /api/ops, so
 * this test pins the wiring end-to-end against a real in-process Postgres:
 * the row exists with the right schedule/timezone/payload, the cron parses
 * to a daily run, and the op it names actually runs as the runner's 'system'
 * actor without error.
 */
describe('segment_snapshot scheduled job (migration 0055)', () => {
  let db: TestDb

  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('seeds one enabled ops_call job named segment_snapshot, daily at 07:00 UTC', async () => {
    const { rows } = await db.query<{
      name: string
      kind: string
      schedule_cron: string | null
      timezone: string
      payload: Record<string, unknown>
      enabled: boolean
    }>(`select name, kind, schedule_cron, timezone, payload, enabled from lp.jobs where name = 'segment_snapshot'`)
    expect(rows).toHaveLength(1)
    const j = rows[0]
    expect(j.kind).toBe('ops_call')
    expect(j.schedule_cron).toBe('0 7 * * *')
    expect(j.timezone).toBe('UTC')
    expect(j.enabled).toBe(true)
    expect(j.payload).toEqual({ op: 'segment_snapshot', args: {} })
  })

  it('the seeded schedule parses to a daily 07:00 UTC run', async () => {
    // Re-using the runner's own parser (lib/jobs/cron.ts) on the row's cron and
    // timezone. nextRun must land exactly on 07:00 UTC the next day, not
    // drift into local time, since the job is pinned to UTC.
    const { nextRun } = await import('@/lib/jobs/cron')
    const { rows } = await db.query<{ schedule_cron: string; timezone: string }>(
      `select schedule_cron, timezone from lp.jobs where name = 'segment_snapshot'`,
    )
    const r = nextRun(rows[0].schedule_cron, new Date('2026-06-01T12:00:00Z'), rows[0].timezone)
    expect(r.toISOString()).toBe('2026-06-02T07:00:00.000Z')
  })

  it('the runner can execute the op the payload names, as the system actor', async () => {
    // Mirrors what runner/handlers/ops_call.mjs does: call /api/ops with the
    // job's payload. segment_snapshot is idempotent and safe for a db with no
    // segments, so it must complete and report a segments count (0 here).
    const result = (await runOp(db, 'system', 'segment_snapshot', {})) as {
      segments: number
      results: { segment_id: number; written: boolean }[]
      alerts: { checked: number; alerted: number }
    }
    expect(result.segments).toBe(0)
    expect(result.results).toEqual([])
    expect(result.alerts).toEqual({ checked: 0, alerted: 0 })
  })
})
