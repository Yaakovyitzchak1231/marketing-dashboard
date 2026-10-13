/**
 * Data-accuracy fixes (Oct 13, 2026): each test pins one root cause with the numbers that were
 * wrong on the live dashboard. Real Postgres (PGlite) so the SQL itself is under test.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact, addTouch } from './helpers/lead-fixtures'
import { loadOverview, liveFilters } from '@/lib/leads/overview'
import { compileSegment, countSegment, matchQuerySql } from '@/lib/segments/compile'
import { exportCsv, liveExportCounts } from '@/lib/export/lead-master'
import { finishRun, latestRunPerJob, listJobRuns, recentFailedRuns, upsertJob } from '@/lib/jobs/store'
import { feed, pendingApprovals } from '@/lib/ops/queries'
import { PENDING_APPROVAL_SQL, unreadCountSql } from '@/lib/ops/counters'
import { ROUTINE_EVENT_SQL, isRoutineEvent } from '@/lib/ops/routine'
import { pendingApprovals as weeklyPendingApprovals } from '@/lib/reports/weekly'
import { APP_TIME_ZONE, formatInAppZone } from '@/lib/time'
import { loadReplyDesk, replyDeskCounts } from '@/lib/leads/replies'
import { scopeSql } from '@/lib/rules/recompute'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('1. merged leads are not counted (Overview showed 34,632)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    const keep = await addCompany(db, { name: 'Keep Co', domain: 'keep.com' })
    const gone = await addCompany(db, { name: 'Keep Co (dupe)' })
    await addCompany(db, { name: 'Other Co', domain: 'other.com' })
    await addContact(db, keep, 'a@keep.com', 'unverified')
    const dupeContact = await addContact(db, gone, 'b@keep.com', 'unverified')
    await db.query('update lp.companies set merged_into = $1 where id = $2', [keep, gone])
    await db.query('update lp.contacts set merged_into = (select min(id) from lp.contacts), email_norm = null where id = $1', [dupeContact])
  })
  afterAll(async () => db.close())

  it('Overview counts each lead once', async () => {
    const o = await loadOverview(db)
    expect(o.companies).toBe(2)
    expect(o.contacts).toBe(1)
    expect(Object.values(o.byStage).reduce((a, b) => a + b, 0)).toBe(2)
    expect(o.needsVerificationCompanies).toBe(1)
  })

  it('a database before migration 0026 still loads (no merged_into filter)', () => {
    expect(liveFilters(false)).toEqual({ co: 'true', ct: 'true', joinedCo: 'true', joinedCt: 'true', coJoin: '' })
  })

  it('segments leave merged tombstones out too', async () => {
    const compiled = await compileSegment(db, { entity: 'company', include: [{ conditions: [{ kind: 'quality', op: 'not_suppressed' }] }] })
    expect(matchQuerySql(compiled)).toContain('c.merged_into is null')
    const counts = await countSegment(db, compiled)
    expect(counts.companies).toBe(2)
  })
})

describe('2. the export says emails vs leads and skips merged rows', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    const a = await addCompany(db, { name: 'Two Emails Co' })
    await addContact(db, a, 'one@two.com', 'valid')
    await addContact(db, a, 'two@two.com', 'valid')
    const b = await addCompany(db, { name: 'Merged Away' })
    await addContact(db, b, 'x@merged.com', 'valid')
    await db.query('update lp.companies set merged_into = $1 where id = $2', [a, b])
  })
  afterAll(async () => db.close())

  it('counts rows (emails) and leads separately', async () => {
    const r = await exportCsv(db)
    expect(r.rows).toBe(2)
    expect(r.leads).toBe(1)
    expect(r.csv).not.toContain('x@merged.com')
    expect(await liveExportCounts(db)).toEqual({ emails: 2, leads: 1 })
  })
})

describe('3. Jobs page reads every job\'s newest run, not the last 40 runs', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await upsertJob(db, 'owner', { name: 'nightly', kind: 'heartbeat' })
    await upsertJob(db, 'owner', { name: 'chatty', kind: 'heartbeat' })
    await db.query(`insert into lp.job_runs (job_name, status, started_at, finished_at) values ('nightly', 'ok', now() - interval '10 hours', now() - interval '10 hours')`)
    await db.query(`insert into lp.job_runs (job_name, status, started_at, finished_at) values ('nightly', 'failed', now() - interval '20 hours', now() - interval '20 hours')`)
    await db.query(`insert into lp.job_runs (job_name, status, started_at, finished_at)
                    select 'chatty', 'ok', now() - (g || ' minutes')::interval, now() - (g || ' minutes')::interval from generate_series(1, 45) g`)
  })
  afterAll(async () => db.close())

  it('the old window hid the nightly job; the new read finds it', async () => {
    const old = await listJobRuns(db, { limit: 40 })
    expect(old.some((r) => r.job_name === 'nightly')).toBe(false)
    const latest = await latestRunPerJob(db)
    expect(latest.map((r) => r.job_name).sort()).toEqual(['chatty', 'nightly'])
    expect(latest.find((r) => r.job_name === 'nightly')?.status).toBe('ok')
  })

  it('failed runs are read on their own, however many ok runs came after', async () => {
    const failed = await recentFailedRuns(db)
    expect(failed.map((r) => r.job_name)).toEqual(['nightly'])
  })
})

describe('4. one definition of pending approvals and unread', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await db.query(`insert into lp.approvals (action, summary, requested_by) values ('send', 'live one', 'tab')`)
    await db.query(`insert into lp.approvals (action, summary, requested_by, expires_at) values ('send', 'expired one', 'tab', now() - interval '1 hour')`)
    await db.query(`insert into lp.notifications (recipient, kind, summary) values ('owner', 'message', 'unread'), ('owner', 'message', 'read')`)
    await db.query(`update lp.notifications set read_at = now() where summary = 'read'`)
  })
  afterAll(async () => db.close())

  it('Overview, Activity and the weekly report agree', async () => {
    const o = await loadOverview(db)
    const activity = await pendingApprovals(db)
    const weekly = await weeklyPendingApprovals(db)
    expect(o.approvalsPending).toBe(1)
    expect(activity.length).toBe(1)
    expect(weekly.map((w) => w.summary)).toEqual(['live one'])
  })

  it('unread counts from the shared SQL', async () => {
    const { rows } = await db.query<{ n: number }>(`select ${unreadCountSql('$1')} as n`, ['owner'])
    expect(Number(rows[0].n)).toBe(1)
    expect(PENDING_APPROVAL_SQL).toContain('expires_at')
  })
})

describe('5. times show in New York, not UTC', () => {
  it('defaults to America/New_York', () => {
    expect(APP_TIME_ZONE).toBe(process.env.DASHBOARD_TZ || 'America/New_York')
  })
  it('a 1:00 AM UTC run reads as 9:00 PM the evening before', () => {
    expect(formatInAppZone('2026-10-14T01:00:00Z', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })).toBe('Oct 13, 9:00 PM')
  })
  it('a calendar date is not shifted a day back', () => {
    expect(formatInAppZone('2026-10-08', { month: 'short', day: 'numeric' })).toBe('Oct 8')
    expect(formatInAppZone('nonsense', { month: 'short' })).toBe('—')
  })
})

describe('6. routine job runs stay out of the activity feeds', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await upsertJob(db, 'owner', { name: 'journey_tick', kind: 'heartbeat' })
    await db.query(`insert into lp.events (actor, kind, summary) values ('owner', 'lead.edited', 'Yaakov edited a lead')`)
    for (let i = 0; i < 5; i++) {
      const { rows } = await db.query<{ id: number }>(`insert into lp.job_runs (job_name, status) values ('journey_tick', 'running') returning id`)
      await finishRun(db, 'system', Number(rows[0].id), { status: 'ok' })
    }
    const { rows } = await db.query<{ id: number }>(`insert into lp.job_runs (job_name, status) values ('journey_tick', 'running') returning id`)
    await finishRun(db, 'system', Number(rows[0].id), { status: 'failed', error: 'boom' })
  })
  afterAll(async () => db.close())

  it('the feed shows the person and the failure, not five ok ticks', async () => {
    const f = await feed(db, { limit: 50 })
    expect(f.map((e) => e.summary)).toEqual(['journey_tick finished: failed (boom)', 'Yaakov edited a lead'])
  })

  it('asking for job events by name still shows them', async () => {
    expect((await feed(db, { kind_prefix: 'job', limit: 50 })).length).toBe(6)
  })

  it('Overview recent leaves them out', async () => {
    const o = await loadOverview(db)
    expect(o.recent.some((e) => e.summary.includes('finished: ok'))).toBe(false)
  })

  it('in-memory rule matches the SQL rule', () => {
    expect(isRoutineEvent({ kind: 'job.finished', data: { status: 'ok' } })).toBe(true)
    expect(isRoutineEvent({ kind: 'job.finished', data: { status: 'failed' } })).toBe(false)
    expect(ROUTINE_EVENT_SQL).toContain("'job.finished'")
  })
})

describe('A. lead scoring never scores a merged-away lead', () => {
  it('every scope excludes merged_into', () => {
    expect(scopeSql({ scope: 'pool', segment: 'jeweler' }).sql).toContain('c.merged_into is null')
    expect(scopeSql({ scope: 'campaign', segment: null }).sql).toContain('c.merged_into is null')
    expect(scopeSql({ scope: 'default', segment: null }).sql).toBe('c.merged_into is null')
    expect(scopeSql({ scope: 'template', segment: null }).sql).toBe('false')
  })
})

describe('B. reply counts are not capped by the 500-lead list', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    await addTouch(db, { email: 'human@reply.com', event: 'reply_received', at: '2026-09-01T10:00:00Z' })
    await db.query(`insert into lp.campaign_touches (email, event_type, occurred_at, source, external_id)
                    select 'b' || g || '@bounce.com', 'email_bounced', timestamptz '2026-10-01T00:00:00Z' + (g || ' minutes')::interval, 'instantly_webhook', 'bx-' || g
                      from generate_series(1, 5) g`)
  })
  afterAll(async () => db.close())

  it('an older waiting reply still counts when newer events fill the list', async () => {
    const list = await loadReplyDesk(db, 5)
    expect(list.some((i) => i.bucket === 'needs_reply')).toBe(false)
    const counts = await replyDeskCounts(db)
    expect(counts.needs_reply).toBe(1)
    expect(counts.bounced).toBe(5)
    expect(counts.total).toBe(6)
    expect((await loadOverview(db)).repliesWaiting).toBe(1)
  })
})
