import Link from 'next/link'
import { PageShell, BUTTON } from '@/components/app/PageShell'
import { Card, SectionHeader, EmptyNote } from '@/components/dashboard/primitives'
import { PrintButton } from '@/components/reports/PrintButton'
import { ActionNote } from '@/components/reports/Note'
import { LevelPill, SampleBanner, SourceErrors, TD, TDN, TH } from '@/components/reports/bits'
import { assignFollowUpAction } from '@/app/actions/reports'
import { loadWeeklyReport } from '@/lib/reports/load'
import { formatDays } from '@/lib/reports/runway'
import { SEGMENT_LABEL } from '@/lib/reports/meta'
import type { WeeklyNumbers, WeeklyReport } from '@/lib/reports/weekly'
import { getDb } from '@/lib/db'
import { formatCount, formatPct } from '@/components/dashboard/format'

export const dynamic = 'force-dynamic'

const n = (v: number | null) => (v === null ? null : formatCount(v))
const p = (v: number | null) => (v === null ? null : formatPct(v))

function Cell({ v }: { v: string | null }) {
  return v === null ? <span className="text-unavailable">no data</span> : <>{v}</>
}

const ROWS: [string, keyof WeeklyNumbers, boolean][] = [
  ['Emails sent', 'sent', false],
  ['New leads contacted', 'contacted', false],
  ['Replies', 'replied', false],
  ['Reply rate', 'replyRate', true],
  ['Interested', 'interested', false],
  ['Meetings booked', 'meetings', false],
  ['Bounces', 'bounced', false],
  ['Bounce rate', 'bounceRate', true],
]

async function agents(): Promise<{ id: string; display_name: string }[]> {
  const db = getDb()
  if (!db) return []
  try {
    const { rows } = await db.query<{ id: string; display_name: string }>(
      `select id, display_name from lp.actors where active and kind = 'agent' and id not in ('system', 'instantly-ai') order by id`,
    )
    return rows
  } catch {
    return []
  }
}

function Numbers({ r }: { r: WeeklyReport }) {
  return (
    <Card className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead className="border-b border-line">
          <tr>
            <th className={TH}></th>
            <th className={`${TH} text-right`}>This week</th>
            <th className={`${TH} text-right`}>Week before</th>
          </tr>
        </thead>
        <tbody>
          {ROWS.map(([label, k, pct]) => (
            <tr key={k} className="border-b border-line-soft last:border-0">
              <td className={TD}>{label}</td>
              <td className={TDN} data-testid={`wk-${k}`}>
                <Cell v={pct ? p(r.thisWeek[k]) : n(r.thisWeek[k])} />
              </td>
              <td className={`${TDN} text-ink-muted`}>
                <Cell v={r.lastWeek ? (pct ? p(r.lastWeek[k]) : n(r.lastWeek[k])) : null} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  )
}

export default async function WeeklyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const [{ report: r, sample }, team] = await Promise.all([loadWeeklyReport(), agents()])
  return (
    <PageShell
      title="Weekly one-pager"
      meta={`${r.period.start ?? '…'} to ${r.period.end} · ${r.period.timezone}`}
      actions={
        <>
          <PrintButton />
          <a href="/api/reports/weekly?format=md" className={`${BUTTON} print:hidden`}>Markdown</a>
          <Link href="/reports" className={`${BUTTON} print:hidden`} prefetch={false}>All reports</Link>
        </>
      }
    >
      {sample ? <SampleBanner /> : null}
      <ActionNote note={sp.note} tone={sp.tone} />
      <SourceErrors errors={r.errors} />

      <div className="grid gap-6 lg:grid-cols-2 print:grid-cols-2">
        <section aria-labelledby="wk-numbers">
          <SectionHeader id="wk-numbers" title="Sends and replies" />
          <Numbers r={r} />
        </section>

        <section aria-labelledby="wk-angles">
          <SectionHeader id="wk-angles" title="Angles" />
          <Card className="px-4 py-3 text-sm">
            {r.best ? (
              <p>
                <span className="text-ink-faint">Best:</span> <strong>{r.best.label}</strong>, {p(r.best.replyRate)} reply rate ({n(r.best.replied)} of {n(r.best.contacted)})
              </p>
            ) : null}
            {r.worst ? (
              <p className="mt-1">
                <span className="text-ink-faint">Worst:</span> <strong>{r.worst.label}</strong>, {p(r.worst.replyRate)} reply rate ({n(r.worst.replied)} of {n(r.worst.contacted)})
              </p>
            ) : null}
            <p className={`text-xs text-ink-faint ${r.best ? 'mt-2' : ''}`}>{r.rankNote}</p>
            {r.angles.length ? (
              <table className="mt-3 w-full border-collapse">
                <thead className="border-b border-line">
                  <tr>
                    <th className={TH}>Angle</th>
                    <th className={`${TH} text-right`}>Contacted</th>
                    <th className={`${TH} text-right`}>Reply rate</th>
                    <th className={`${TH} text-right`}>Meetings</th>
                  </tr>
                </thead>
                <tbody>
                  {r.angles.map((a) => (
                    <tr key={a.key} className="border-b border-line-soft last:border-0">
                      <td className={TD}>{a.label}</td>
                      <td className={TDN}><Cell v={n(a.contacted)} /></td>
                      <td className={TDN}><Cell v={p(a.replyRate)} /></td>
                      <td className={TDN}><Cell v={n(a.meetings)} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </Card>
        </section>

        <section aria-labelledby="wk-runway">
          <SectionHeader id="wk-runway" title="Lead runway" />
          <Card className="divide-y divide-line-soft text-sm">
            {r.segmentRunway.length === 0 && r.campaignRunway.filter((c) => c.status === 'active').length === 0 ? (
              <EmptyNote>Nothing sending right now.</EmptyNote>
            ) : null}
            {r.segmentRunway.map((s) => (
              <div key={s.segment} className="flex items-center justify-between gap-2 px-4 py-2">
                <span>{SEGMENT_LABEL[s.segment]} (all leads)</span>
                <span className="flex items-center gap-2 font-numeric tabular-nums">
                  {s.level === 'not_sending' ? 'not sending' : formatDays(s.days)} <LevelPill level={s.level} />
                </span>
              </div>
            ))}
            {r.campaignRunway
              .filter((c) => c.status === 'active')
              .map((c) => (
                <div key={c.id} className="flex items-center justify-between gap-2 px-4 py-2">
                  <span className="min-w-0 truncate">{c.name}</span>
                  <span className="flex shrink-0 items-center gap-2 font-numeric tabular-nums">
                    {formatDays(c.days)} <LevelPill level={c.level} />
                  </span>
                </div>
              ))}
          </Card>
        </section>

        <section aria-labelledby="wk-open" className="lg:col-span-2 print:col-span-2">
          <SectionHeader id="wk-open" title="Open items" meta={`${r.openItems.length} open`} />
          <Card className="divide-y divide-line-soft">
            {r.openItems.length === 0 ? <EmptyNote>Nothing open.</EmptyNote> : null}
            {r.openItems.map((i) => (
              <div key={i.id} className="flex flex-col gap-2 px-4 py-2.5 sm:flex-row sm:items-center sm:justify-between" data-testid="open-item">
                <div className="min-w-0 text-sm">
                  <div className="text-ink">
                    {i.href ? (
                      <Link href={i.href} prefetch={false} className="hover:text-accent">{i.title}</Link>
                    ) : (
                      i.title
                    )}
                  </div>
                  {i.detail ? <div className="text-xs text-ink-faint">{i.detail}</div> : null}
                </div>
                {i.kind !== 'task' && team.length ? (
                  <form action={assignFollowUpAction} className="flex shrink-0 items-center gap-1.5 print:hidden">
                    <input type="hidden" name="title" value={i.title} />
                    <input type="hidden" name="detail" value={i.detail ?? ''} />
                    <input type="hidden" name="href" value={i.href ?? ''} />
                    <input type="hidden" name="item_id" value={i.id} />
                    <input type="hidden" name="return_to" value="/reports/weekly" />
                    <select name="assigned_to" aria-label={`Who follows up on ${i.title}`} className="rounded-control border border-line bg-surface px-2 py-1 text-xs" defaultValue="tab">
                      {team.map((a) => (
                        <option key={a.id} value={a.id}>{a.display_name}</option>
                      ))}
                    </select>
                    <button type="submit" className={BUTTON}>Assign follow-up</button>
                  </form>
                ) : i.kind === 'task' ? (
                  <span className="shrink-0 text-xs text-ink-faint">{i.assignedTo ? `with ${i.assignedTo}` : 'unassigned'}</span>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      </div>
      <p className="mt-6 text-2xs text-ink-faint">
        Generated {r.generatedAt}. Numbers from Instantly and the lead database; “no data” means nobody reported it.
      </p>
    </PageShell>
  )
}
