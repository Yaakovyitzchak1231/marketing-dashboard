import Link from 'next/link'
import { getDb } from '@/lib/db'
import { listFindJobs, measuredEta, type FindJob } from '@/lib/engine/jobs'
import { AI_AGENCY_QUERIES, JEWELER_QUERIES, describeGeography } from '@/engine/params'
import { DROP_REASON_WORDS } from '@/engine/parse/filter'
import { FindForm } from '@/components/find/FindForm'
import { CancelJob } from '@/components/find/CancelJob'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { Ago, DbNotConnected, PageFrame, TaskStatus } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'

export const dynamic = 'force-dynamic'

const STAGE_WORDS: Record<string, string> = {
  discover: 'Finding businesses',
  crawl: 'Reading websites',
  owner: 'Searching for owners',
  build: 'Adding to Leads',
  done: 'Finished',
}

function n(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function Num({ v }: { v: unknown }) {
  const x = n(v)
  return x == null ? <span className="text-unavailable">—</span> : <>{x.toLocaleString('en-US')}</>
}

function fmtEta(s: number): string {
  if (s < 90) return `about ${Math.max(1, Math.round(s / 10) * 10)} s left`
  if (s < 5400) return `about ${Math.round(s / 60)} min left`
  return `about ${(s / 3600).toFixed(1)} h left`
}

function JobRow({ job, now }: { job: FindJob; now: Date }) {
  const c = (job.run?.counters ?? {}) as Record<string, unknown>
  const live = ['queued', 'claimed', 'running', 'blocked'].includes(job.status)
  const eta = measuredEta(job, now.getTime())
  const dropped = (c.dropped ?? {}) as Record<string, number>
  const dropList = Object.entries(dropped).sort((a, b) => b[1] - a[1])
  const kept = n(c.kept)
  const steps: [string, unknown, string][] = [
    ['Searches', c.searches_done, n(c.searches_total) != null ? `of ${n(c.searches_total)!.toLocaleString('en-US')}` : ''],
    ['Businesses seen', c.places_seen, ''],
    ['Independents kept', c.kept, ''],
    ['Websites read', c.crawled, kept != null ? `of ${kept.toLocaleString('en-US')}` : ''],
    ['Added to Leads', c.built, ''],
    ['New emails', c.emails_new, ''],
    ['Owner names', c.owners_found, ''],
  ]
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="text-[14px] font-semibold text-ink">
          #{job.id} {job.title}
        </p>
        <TaskStatus status={job.status} />
        <span className="ml-auto text-[11.5px] text-ink-faint">
          started <Ago at={job.created_at} now={now} />
          {job.claimed_by ? <> · runner {job.claimed_by}</> : job.status === 'queued' ? <> · waiting for {job.assigned_to ?? 'a runner'}</> : null}
        </span>
      </div>
      <p className="mt-1 text-[12.5px] text-ink-muted">
        {job.run ? STAGE_WORDS[job.run.stage ?? ''] ?? job.run.stage : job.status === 'queued' ? 'Not started yet' : '—'}
        {live && job.run?.heartbeat_at ? <> · last update <Ago at={job.run.heartbeat_at} now={now} /></> : null}
        {eta ? <span title={`Measured from this run: ${eta.basis}`}> · {fmtEta(eta.seconds)}</span> : null}
        {' · '}
        {describeGeography(job.params)}
      </p>
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-[11.5px] sm:grid-cols-4 lg:grid-cols-7">
        {steps.map(([k, v, extra]) => (
          <div key={k}>
            <dt className="text-ink-faint">{k}</dt>
            <dd className="mt-0.5 text-[15px] font-medium tabular-nums text-ink">
              {job.run ? <Num v={v} /> : <span className="text-unavailable">—</span>}
              {extra && job.run ? <span className="ml-1 text-[11px] font-normal text-ink-faint">{extra}</span> : null}
            </dd>
          </div>
        ))}
      </dl>
      {dropList.length ? (
        <details className="mt-3 text-[12px] text-ink-muted">
          <summary className="cursor-pointer text-ink-faint">Why businesses were left out</summary>
          <ul className="mt-1.5 grid max-w-2xl gap-x-10 gap-y-0.5 sm:grid-cols-2">
            {dropList.map(([reason, count]) => (
              <li key={reason} className="flex justify-between gap-3 border-b border-line/60 py-0.5">
                <span>{DROP_REASON_WORDS[reason] ?? reason}</span>
                <span className="tabular-nums">{count.toLocaleString('en-US')}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {job.run?.notes?.length ? (
        <ul className="mt-3 space-y-1 text-[12px] text-warn">
          {job.run.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      ) : null}
      {job.error || job.run?.error ? <p className="mt-2 text-[12px] text-bad">{job.run?.error ?? job.error}</p> : null}
      {job.report && job.status === 'done' ? <p className="mt-2 text-[12.5px] text-ink">{job.report}</p> : null}
      <div className="mt-3 flex flex-wrap items-center gap-4 text-[12.5px]">
        {n(c.built) ? (
          <Link href={`/leads?job=${job.id}`} className="font-medium text-accent hover:underline">
            See the {n(c.built)!.toLocaleString('en-US')} leads from this job
          </Link>
        ) : null}
        <Link href={`/team/${job.id}`} className="text-ink-muted hover:underline">
          Task thread
        </Link>
        {live ? <CancelJob id={job.id} /> : null}
      </div>
    </Card>
  )
}

export default async function FindPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Find leads" meta="Tab's lead engine: find businesses, read their websites, add them to Leads">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const jobs = await listFindJobs(db)
  const now = new Date()
  const anyLive = jobs.some((j) => ['queued', 'claimed', 'running'].includes(j.status))
  return (
    <PageFrame title="Find leads" meta="Tab's lead engine: the method behind the Oct 6 jeweler list, run on demand. Results land in Leads with the page each fact came from.">
      {anyLive ? <AutoRefresh seconds={5} /> : null}
      <section className="mb-6">
        <SectionHeader title="New job" />
        <Card>
          <FindForm jewelerQueries={JEWELER_QUERIES} agencyQueries={AI_AGENCY_QUERIES} />
        </Card>
      </section>
      <section className="mb-6">
        <SectionHeader title="Jobs" meta={jobs.length ? `${jobs.length} most recent` : undefined} />
        {jobs.length ? (
          <div className="grid gap-3">
            {jobs.map((j) => (
              <JobRow key={j.id} job={j} now={now} />
            ))}
          </div>
        ) : (
          <Card>
            <EmptyNote>No jobs yet. Start one above; Tab&apos;s runner picks it up and progress shows here.</EmptyNote>
          </Card>
        )}
      </section>
      <p className="max-w-3xl text-[12px] leading-relaxed text-ink-faint">
        Jobs run on Tab&apos;s runner (a server, not this website), so they keep going for hours and pick up where they stopped after a restart. Finding businesses reads
        Google Maps search results directly, which Google&apos;s terms don&apos;t allow; a CSV or open map data file can be used instead from the runner. Owner search needs a
        search provider on the runner (a self-hosted SearXNG is free). No paid checks run here; verification is its own screen.
      </p>
    </PageFrame>
  )
}
