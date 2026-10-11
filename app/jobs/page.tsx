import { getDb } from '@/lib/db'
import { listCampaigns } from '@/lib/campaigns/store'
import { listJobRuns, listJobs } from '@/lib/jobs/store'
import { loadRunnerSignals, runnerLabel, runnerStatus, type RunnerStatus } from '@/lib/jobs/runner-status'
import { Card, EmptyNote, Pill, SectionHeader, type PillTone } from '@/components/dashboard/primitives'
import { saveJobAction, runJobNowAction, toggleJobAction } from '@/app/actions/jobs'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined

const rel = (iso: string | null) => {
  if (!iso) return '—'
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return '—'
  const diff = ms - Date.now()
  const abs = Math.abs(diff)
  const mins = Math.round(abs / 60000)
  const unit = mins < 60 ? `${mins}m` : mins < 1440 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`
  return diff >= 0 ? `in ${unit}` : `${unit} ago`
}

const abs = (iso: string | null) => {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })
}

/** A short, human reading of the common cron shapes; falls back to the raw expression for anything else. */
function describeCron(expr: string | null, tz: string): string {
  if (!expr) return 'on demand only'
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return `${expr} (${tz})`
  const [min, hour, dom, month, dow] = parts
  const hh = (h: string, m: string) => {
    const hn = Number(h)
    const mn = Number(m)
    if (!Number.isInteger(hn) || !Number.isInteger(mn)) return null
    const period = hn < 12 ? 'am' : 'pm'
    const h12 = hn % 12 === 0 ? 12 : hn % 12
    return `${h12}:${String(mn).padStart(2, '0')}${period}`
  }
  if (dom === '*' && month === '*' && dow === '*' && /^\d+$/.test(hour) && /^\d+$/.test(min)) {
    const t = hh(hour, min)
    return t ? `daily at ${t} (${tz})` : `${expr} (${tz})`
  }
  if (dom === '*' && month === '*' && /^\d+$/.test(hour) && /^\d+$/.test(min) && /^[0-9,-]+$/.test(dow) && dow !== '*') {
    const t = hh(hour, min)
    const DOWN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    const days = dow.split(',').map((d) => DOWN[Number(d)] ?? d).join(',')
    return t ? `${days} at ${t} (${tz})` : `${expr} (${tz})`
  }
  if (min.startsWith('*/') && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `every ${min.slice(2)} min`
  }
  return `${expr} (${tz})`
}

const STATUS_TONE: Record<string, PillTone> = {
  ok: 'good',
  running: 'accent',
  failed: 'bad',
  timeout: 'bad',
  skipped: 'warn',
}

const RUNNER_TONE: Record<RunnerStatus['state'], PillTone> = { online: 'good', offline: 'warn', never: 'neutral' }

export default async function JobsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const error = one(sp.error)
  const db = getDb()

  if (!db) {
    return (
      <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
        <header className="mb-6">
          <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Jobs</h1>
        </header>
        <Card>
          <EmptyNote>The lead database isn&apos;t connected yet (DATABASE_URL is not set), so there are no jobs to show.</EmptyNote>
        </Card>
      </main>
    )
  }

  const [jobs, runs, campaigns, runnerSignals] = await Promise.all([
    listJobs(db),
    listJobRuns(db, { limit: 40 }),
    listCampaigns(db, {}),
    loadRunnerSignals(db).catch(() => null),
  ])
  const now = new Date()
  const runner: RunnerStatus | null = runnerSignals ? runnerStatus(runnerSignals, now) : null
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]))
  const runsByJob = new Map<string, typeof runs>()
  for (const r of runs) {
    const list = runsByJob.get(r.job_name) ?? []
    list.push(r)
    runsByJob.set(r.job_name, list)
  }
  const failingRuns = runs.filter((r) => r.status === 'failed' || r.status === 'timeout').slice(0, 20)

  return (
    <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Jobs</h1>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">
          The background runner on the OVH server: what runs, on what schedule, and how its last run went.
        </p>
        <div className="mt-2">
          {runner ? (
            <Pill
              tone={RUNNER_TONE[runner.state]}
              title={runner.lastSeen ? `Last heartbeat ${abs(runner.lastSeen)}` : 'No heartbeat yet. See docs/RUNNER.md to start it.'}
            >
              {runnerLabel(runner, now)}
            </Pill>
          ) : (
            <Pill tone="neutral">Runner status unavailable</Pill>
          )}
        </div>
      </header>

      {error ? (
        <Card className="mb-4 border-bad/30 bg-bad-soft">
          <p className="px-4 py-3 text-[13px] text-bad">{error}</p>
        </Card>
      ) : null}

      <section aria-labelledby="jobs-list" className="mt-2">
        <SectionHeader id="jobs-list" title="Jobs" meta={`${jobs.length} job${jobs.length === 1 ? '' : 's'}`} />
        <Card>
          {jobs.length === 0 ? (
            <EmptyNote>No jobs yet. Add one below.</EmptyNote>
          ) : (
            <div className="divide-y divide-line-soft">
              {jobs.map((j) => {
                const lastRun = runsByJob.get(j.name)?.[0] ?? null
                return (
                  <div key={j.name} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
                    <div className="min-w-[160px] flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[13px] font-medium text-ink">{j.name}</span>
                        <Pill tone="neutral">{j.kind}</Pill>
                        {j.campaign_id ? <Pill tone="accent">{campaignName.get(j.campaign_id) ?? `campaign ${j.campaign_id}`}</Pill> : null}
                      </div>
                      {j.description ? <p className="mt-0.5 text-[12px] text-ink-faint">{j.description}</p> : null}
                      <p className="mt-0.5 text-[11px] text-ink-faint">{describeCron(j.schedule_cron, j.timezone)}</p>
                    </div>
                    <div className="w-[140px] shrink-0 text-[12px] text-ink-muted">
                      <div>next {j.enabled ? rel(j.next_run_at) : '—'}</div>
                      <div className="text-ink-faint">{j.enabled ? abs(j.next_run_at) : 'disabled'}</div>
                    </div>
                    <div className="w-[160px] shrink-0 text-[12px]">
                      {lastRun ? (
                        <>
                          <Pill tone={STATUS_TONE[lastRun.status] ?? 'neutral'}>{lastRun.status}</Pill>
                          <div className="mt-0.5 text-ink-faint">{rel(lastRun.finished_at ?? lastRun.started_at)}</div>
                        </>
                      ) : (
                        <span className="text-ink-faint">never run</span>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <form action={toggleJobAction}>
                        <input type="hidden" name="name" value={j.name} />
                        <input type="hidden" name="enabled" value={j.enabled ? 'false' : 'true'} />
                        <button type="submit" className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink">
                          {j.enabled ? 'Disable' : 'Enable'}
                        </button>
                      </form>
                      <form action={runJobNowAction}>
                        <input type="hidden" name="name" value={j.name} />
                        <button type="submit" className="rounded-full border border-line px-2.5 py-1 text-[12px] text-ink-muted hover:text-ink">
                          Run now
                        </button>
                      </form>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </Card>
      </section>

      <section aria-labelledby="jobs-new" className="mt-6">
        <SectionHeader id="jobs-new" title="Add a job" />
        <Card className="px-4 py-4">
          <form action={saveJobAction} className="grid gap-3 sm:grid-cols-2">
            <label className="text-[12px] text-ink-muted">
              Name
              <input name="name" required placeholder="nightly-heartbeat" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted">
              Kind (handler)
              <input name="kind" required placeholder="heartbeat" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted sm:col-span-2">
              Description
              <input name="description" placeholder="what this job does" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted">
              Schedule (cron, blank = on demand only)
              <input name="schedule_cron" placeholder="0 9 * * *" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted">
              Timezone
              <input name="timezone" placeholder="America/New_York" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted">
              Campaign (optional)
              <select name="campaign_id" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]">
                <option value="">Workspace-wide</option>
                {campaigns.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[12px] text-ink-muted">
              Timeout (seconds)
              <input name="timeout_s" type="number" placeholder="600" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 text-[13px]" />
            </label>
            <label className="text-[12px] text-ink-muted sm:col-span-2">
              Payload (JSON, e.g. {'{"url":"https://..."}'})
              <textarea name="payload" rows={2} placeholder="{}" className="mt-1 w-full rounded-input border border-line px-2.5 py-1.5 font-mono text-[12px]" />
            </label>
            <label className="flex items-center gap-2 text-[12px] text-ink-muted">
              <input type="checkbox" name="enabled" defaultChecked />
              Enabled
            </label>
            <div className="sm:col-span-2">
              <button type="submit" className="rounded-full bg-ink px-3.5 py-1.5 text-[12px] font-medium text-canvas">
                Save job
              </button>
            </div>
          </form>
        </Card>
      </section>

      <section aria-labelledby="jobs-errors" className="mt-6">
        <SectionHeader id="jobs-errors" title="Recent runs with errors" />
        <Card>
          {failingRuns.length === 0 ? (
            <EmptyNote>No failed or timed-out runs.</EmptyNote>
          ) : (
            <div className="divide-y divide-line-soft">
              {failingRuns.map((r) => (
                <div key={r.id} className="px-4 py-2.5 text-[12px]">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-ink">{r.job_name}</span>
                    <Pill tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</Pill>
                    <span className="text-ink-faint">{abs(r.started_at)}</span>
                  </div>
                  {r.error ? <p className="mt-0.5 text-ink-faint">{r.error}</p> : null}
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>
    </main>
  )
}
