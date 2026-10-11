import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import {
  claimDueJobs, finishRun, getJob, listJobRuns, listJobs, reapStale, runNow, setEnabled, upsertJob,
} from '@/lib/jobs/store'
import { JOB_OPS } from '@/lib/jobs/ops'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('lib/jobs/store (real Postgres via PGlite)', () => {
  let db: TestDb
  let campaignId: number
  beforeAll(async () => {
    db = await createTestDb()
    const c = await createCampaign(db, 'owner', { name: 'Jobs test campaign' })
    campaignId = c.id
  })
  afterAll(async () => {
    await db.close()
  })

  it('upsertJob creates a job and computes next_run_at from its cron', async () => {
    const j = await upsertJob(db, 'owner', { name: 'nightly-heartbeat', kind: 'heartbeat', schedule_cron: '0 2 * * *', timezone: 'America/New_York' })
    expect(j.name).toBe('nightly-heartbeat')
    expect(j.enabled).toBe(true)
    expect(j.timeout_s).toBe(600)
    expect(j.next_run_at).not.toBeNull()
  })

  it('upsertJob rejects a bad cron expression with a clear error', async () => {
    await expect(upsertJob(db, 'owner', { name: 'bad-job', kind: 'heartbeat', schedule_cron: '99 * * * *' })).rejects.toThrow(/bad schedule/)
  })

  it('upsertJob rejects a bad name or kind', async () => {
    await expect(upsertJob(db, 'owner', { name: 'Bad Name!', kind: 'heartbeat' })).rejects.toThrow(OpsError)
    await expect(upsertJob(db, 'owner', { name: 'ok-name', kind: 'Bad Kind!' })).rejects.toThrow(OpsError)
  })

  it('a job with no schedule has no next_run_at (on-demand only)', async () => {
    const j = await upsertJob(db, 'owner', { name: 'on-demand-job', kind: 'heartbeat' })
    expect(j.schedule_cron).toBeNull()
    expect(j.next_run_at).toBeNull()
  })

  it('listJobs / getJob read back what was written', async () => {
    const all = await listJobs(db)
    expect(all.map((j) => j.name)).toEqual(expect.arrayContaining(['nightly-heartbeat', 'on-demand-job']))
    const one = await getJob(db, 'nightly-heartbeat')
    expect(one?.kind).toBe('heartbeat')
    expect(await getJob(db, 'does-not-exist')).toBeNull()
  })

  it('upsertJob can target a campaign', async () => {
    const j = await upsertJob(db, 'owner', { name: 'campaign-job', kind: 'ops_call', campaign_id: campaignId, payload: { op: 'whoami' } })
    expect(j.campaign_id).toBe(campaignId)
    expect(j.payload).toEqual({ op: 'whoami' })
  })

  it('setEnabled disables a job (next_run_at left alone) and re-enabling recomputes it', async () => {
    await upsertJob(db, 'owner', { name: 'toggle-job', kind: 'heartbeat', schedule_cron: '*/5 * * * *' })
    const off = await setEnabled(db, 'owner', 'toggle-job', false)
    expect(off.enabled).toBe(false)
    const on = await setEnabled(db, 'owner', 'toggle-job', true)
    expect(on.enabled).toBe(true)
    expect(on.next_run_at).not.toBeNull()
  })

  it('runNow queues an immediate run by moving next_run_at to now', async () => {
    const j = await upsertJob(db, 'owner', { name: 'run-now-job', kind: 'heartbeat', schedule_cron: '0 0 1 1 *' }) // once a year
    const farOut = j.next_run_at
    const queued = await runNow(db, 'owner', 'run-now-job')
    expect(queued.next_run_at).not.toBe(farOut)
    expect(new Date(queued.next_run_at as string).getTime()).toBeLessThanOrEqual(Date.now() + 1000)
  })

  it('claimDueJobs: FOR UPDATE SKIP LOCKED means a second claimer never gets a job the first is holding', async () => {
    await upsertJob(db, 'owner', { name: 'claim-test-1', kind: 'heartbeat', schedule_cron: '* * * * *' })
    await upsertJob(db, 'owner', { name: 'claim-test-2', kind: 'heartbeat', schedule_cron: '* * * * *' })
    await runNow(db, 'owner', 'claim-test-1')
    await runNow(db, 'owner', 'claim-test-2')

    const firstClaim = await claimDueJobs(db, 'runner-a', 10)
    const names1 = firstClaim.map((c) => c.job.name)
    expect(names1).toContain('claim-test-1')
    expect(names1).toContain('claim-test-2')

    // A second runner polling right after gets nothing of what the first is holding
    // (both are locked_until in the future), simulating two claimers racing.
    const secondClaim = await claimDueJobs(db, 'runner-b', 10)
    const overlap = secondClaim.filter((c) => names1.includes(c.job.name))
    expect(overlap).toHaveLength(0)
  })

  it('claimDueJobs sets locked_by / locked_until and inserts a running job_runs row', async () => {
    await upsertJob(db, 'owner', { name: 'lock-check', kind: 'heartbeat', schedule_cron: '* * * * *', timeout_s: 120 })
    await runNow(db, 'owner', 'lock-check')
    const [claim] = await claimDueJobs(db, 'runner-lock', 1)
    expect(claim.job.name).toBe('lock-check')
    expect(claim.job.locked_by).toBe('runner-lock')
    expect(claim.job.locked_until).not.toBeNull()
    const runs = await listJobRuns(db, { job_name: 'lock-check' })
    expect(runs[0]).toMatchObject({ id: claim.run_id, status: 'running', actor: 'system', runner: 'runner-lock' })
  })

  it('a disabled job is never claimed even if next_run_at is in the past', async () => {
    const j = await upsertJob(db, 'owner', { name: 'disabled-due', kind: 'heartbeat', schedule_cron: '* * * * *' })
    await runNow(db, 'owner', 'disabled-due')
    await setEnabled(db, 'owner', 'disabled-due', false)
    const claimed = await claimDueJobs(db, 'runner-c', 20)
    expect(claimed.map((c) => c.job.name)).not.toContain('disabled-due')
    void j
  })

  it('finishRun closes the run, clears the lock, and computes the next next_run_at from cron', async () => {
    await upsertJob(db, 'owner', { name: 'finish-ok', kind: 'heartbeat', schedule_cron: '*/5 * * * *' })
    await runNow(db, 'owner', 'finish-ok')
    const [claim] = await claimDueJobs(db, 'runner-finish', 1)
    const run = await finishRun(db, 'system', claim.run_id, { status: 'ok', output: { did: 'something' } })
    expect(run.status).toBe('ok')
    expect(run.output).toEqual({ did: 'something' })
    const job = await getJob(db, 'finish-ok')
    expect(job?.locked_by).toBeNull()
    expect(job?.locked_until).toBeNull()
    expect(job?.last_status).toBe('ok')
    expect(job?.next_run_at).not.toBeNull()
    expect(new Date(job!.next_run_at as string).getTime()).toBeGreaterThan(Date.now())
  })

  it('finishRun writes one lp.events job.finished row', async () => {
    await upsertJob(db, 'owner', { name: 'finish-events', kind: 'heartbeat', schedule_cron: '0 0 1 1 *' })
    await runNow(db, 'owner', 'finish-events')
    const [claim] = await claimDueJobs(db, 'runner-events', 1)
    await finishRun(db, 'system', claim.run_id, { status: 'ok' })
    const { rows } = await db.query<{ kind: string; entity_id: string; summary: string }>(
      "select kind, entity_id, summary from lp.events where kind = 'job.finished' and entity_id = 'finish-events'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].summary).toContain('finish-events')
  })

  it('a failed run still reschedules on its cron (does not stop the job forever)', async () => {
    await upsertJob(db, 'owner', { name: 'finish-failed', kind: 'heartbeat', schedule_cron: '*/10 * * * *' })
    await runNow(db, 'owner', 'finish-failed')
    const [claim] = await claimDueJobs(db, 'runner-failed', 1)
    await finishRun(db, 'system', claim.run_id, { status: 'failed', error: 'boom' })
    const job = await getJob(db, 'finish-failed')
    expect(job?.last_status).toBe('failed')
    expect(job?.last_error).toBe('boom')
    expect(job?.next_run_at).not.toBeNull()
  })

  it('finishRun on an already-finished run throws (no double-finish)', async () => {
    await upsertJob(db, 'owner', { name: 'double-finish', kind: 'heartbeat', schedule_cron: '0 0 1 1 *' })
    await runNow(db, 'owner', 'double-finish')
    const [claim] = await claimDueJobs(db, 'runner-double', 1)
    await finishRun(db, 'system', claim.run_id, { status: 'ok' })
    await expect(finishRun(db, 'system', claim.run_id, { status: 'ok' })).rejects.toThrow(OpsError)
  })

  it('reapStale marks a run whose lock expired as timeout and frees the job', async () => {
    await upsertJob(db, 'owner', { name: 'stale-job', kind: 'heartbeat', schedule_cron: '* * * * *', timeout_s: 1 })
    await runNow(db, 'owner', 'stale-job')
    const [claim] = await claimDueJobs(db, 'runner-stale', 1)
    // Force the lock into the past, as if the runner crashed mid-run.
    await db.query("update lp.jobs set locked_until = now() - interval '1 minute' where name = 'stale-job'")
    const reaped = await reapStale(db)
    expect(reaped).toContain('stale-job')
    const job = await getJob(db, 'stale-job')
    expect(job?.locked_by).toBeNull()
    expect(job?.last_status).toBe('timeout')
    const runs = await listJobRuns(db, { job_name: 'stale-job' })
    const run = runs.find((r) => r.id === claim.run_id)
    expect(run?.status).toBe('timeout')
  })

  it('JOB_OPS.claim_jobs and finish_job_run refuse any actor that is not \'system\'', async () => {
    await upsertJob(db, 'owner', { name: 'perm-test', kind: 'heartbeat', schedule_cron: '* * * * *' })
    await runNow(db, 'owner', 'perm-test')
    await expect(JOB_OPS.claim_jobs.run(db, 'owner', { runner: 'x' })).rejects.toThrow(OpsError)
    await expect(JOB_OPS.claim_jobs.run(db, 'tab', { runner: 'x' })).rejects.toThrow(OpsError)
    const ok = (await JOB_OPS.claim_jobs.run(db, 'system', { runner: 'perm-runner' })) as Array<{ run_id: number }>
    expect(ok.length).toBeGreaterThan(0)
    await expect(JOB_OPS.finish_job_run.run(db, 'owner', { run_id: ok[0].run_id, status: 'ok' })).rejects.toThrow(OpsError)
    const finished = await JOB_OPS.finish_job_run.run(db, 'system', { run_id: ok[0].run_id, status: 'ok' })
    expect(finished).toMatchObject({ status: 'ok' })
  })

  it('JOB_OPS.put_job and run_job_now refuse a non-owner, non-system actor', async () => {
    await expect(JOB_OPS.put_job.run(db, 'claude', { name: 'nope', kind: 'heartbeat' })).rejects.toThrow(OpsError)
    await expect(JOB_OPS.put_job.run(db, 'system', { name: 'system-made', kind: 'heartbeat' })).resolves.toMatchObject({ name: 'system-made' })
    await expect(JOB_OPS.run_job_now.run(db, 'hermes', { name: 'system-made' })).rejects.toThrow(OpsError)
  })

  it('JOB_OPS.list_jobs and job_runs are readable by anyone', async () => {
    const jobs = (await JOB_OPS.list_jobs.run(db, 'hermes', {})) as Array<{ name: string }>
    expect(jobs.length).toBeGreaterThan(0)
    const runs = (await JOB_OPS.job_runs.run(db, 'claude', { limit: 5 })) as Array<{ id: number }>
    expect(Array.isArray(runs)).toBe(true)
  })
})
