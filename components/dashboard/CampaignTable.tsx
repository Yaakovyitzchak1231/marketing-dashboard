'use client'

import { Fragment, useMemo, useState } from 'react'
import type { CampaignRow, CampaignStatus, StepStat } from '@/lib/dashboard/types'
import { formatCount, formatPct } from './format'
import { Card, EmptyNote, Pill, SectionHeader, Val, type PillTone } from './primitives'

const STATUS: Record<CampaignStatus, { label: string; tone: PillTone; rank: number }> = {
  active: { label: 'Active', tone: 'good', rank: 0 },
  error: { label: 'Error', tone: 'bad', rank: 1 },
  paused: { label: 'Paused', tone: 'warn', rank: 2 },
  draft: { label: 'Draft', tone: 'neutral', rank: 3 },
  completed: { label: 'Completed', tone: 'neutral', rank: 4 },
  unknown: { label: 'Unknown', tone: 'neutral', rank: 5 },
}

type SortKey = 'name' | 'status' | 'sent' | 'contacted' | 'replied' | 'replyRate' | 'positiveRate' | 'bounceRate' | 'leadsRemaining'

const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'sent', label: 'Sent', title: 'Emails sent, all steps' },
  { key: 'contacted', label: 'Contacted', title: 'Distinct leads who got step 1 in the range' },
  { key: 'replied', label: 'Replies', title: 'Leads who replied (auto-replies excluded)' },
  { key: 'replyRate', label: 'Reply rate', title: 'Replies ÷ leads contacted' },
  { key: 'positiveRate', label: 'Positive', title: 'Leads marked interested ÷ leads contacted' },
  { key: 'bounceRate', label: 'Bounce', title: 'Bounced ÷ emails sent' },
  { key: 'leadsRemaining', label: 'Leads left', title: 'Leads in the campaign not contacted yet' },
]

function sortValue(c: CampaignRow, key: SortKey): number | string | null {
  switch (key) {
    case 'name': return c.name.toLowerCase()
    case 'status': return STATUS[c.status]?.rank ?? 9
    case 'sent': return c.counts.sent
    case 'contacted': return c.counts.contacted
    case 'replied': return c.counts.replied
    case 'replyRate': return c.rates.replyRate
    case 'positiveRate': return c.rates.positiveRate
    case 'bounceRate': return c.rates.bounceRate
    case 'leadsRemaining': return c.leadsRemaining
  }
}

/** Sort with nulls always last, whichever direction. Exported for tests. */
export function sortCampaigns(rows: CampaignRow[], key: SortKey, dir: 'asc' | 'desc'): CampaignRow[] {
  return [...rows].sort((a, b) => {
    const va = sortValue(a, key)
    const vb = sortValue(b, key)
    if (va === null && vb === null) return a.name.localeCompare(b.name)
    if (va === null) return 1
    if (vb === null) return -1
    const cmp = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : (va as number) - (vb as number)
    return (dir === 'asc' ? cmp : -cmp) || a.name.localeCompare(b.name)
  })
}

function cellValue(c: CampaignRow, key: SortKey) {
  switch (key) {
    case 'sent': return <Val value={c.counts.sent}>{formatCount(c.counts.sent)}</Val>
    case 'contacted': return <Val value={c.counts.contacted}>{formatCount(c.counts.contacted)}</Val>
    case 'replied': return <Val value={c.counts.replied}>{formatCount(c.counts.replied)}</Val>
    case 'replyRate': return <Val value={c.rates.replyRate}>{formatPct(c.rates.replyRate)}</Val>
    case 'positiveRate': return <Val value={c.rates.positiveRate}>{formatPct(c.rates.positiveRate)}</Val>
    case 'bounceRate': return <Val value={c.rates.bounceRate}>{formatPct(c.rates.bounceRate)}</Val>
    case 'leadsRemaining': return <Val value={c.leadsRemaining}>{formatCount(c.leadsRemaining)}</Val>
    default: return null
  }
}

function StatusPill({ status }: { status: CampaignStatus }) {
  const s = STATUS[status] ?? STATUS.unknown
  return <Pill tone={s.tone}>{s.label}</Pill>
}

function OpenRate({ c }: { c: CampaignRow }) {
  if (c.openTracking === false) return <span className="text-ink-faint">tracking off</span>
  return <Val value={c.rates.openRate}>{formatPct(c.rates.openRate)}</Val>
}

function StepsDetail({ c }: { c: CampaignRow }) {
  const steps = [...c.steps].sort((a, b) => a.step - b.step || a.variant.localeCompare(b.variant))
  const trackingOn = c.openTracking !== false
  const best = bestStep(steps)
  return (
    <div className="space-y-3">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[12px]">
        <Stat label="Open rate"><OpenRate c={c} /></Stat>
        <Stat label="Positive replies"><Val value={c.counts.positive}>{formatCount(c.counts.positive)}</Val></Stat>
        <Stat label="Meetings"><Val value={c.counts.meetingsBooked}>{formatCount(c.counts.meetingsBooked)}</Val></Stat>
        <Stat label="Auto-replies"><Val value={c.counts.autoReplies}>{formatCount(c.counts.autoReplies)}</Val></Stat>
        <Stat label="Bounced"><Val value={c.counts.bounced}>{formatCount(c.counts.bounced)}</Val></Stat>
        <Stat label="Leads total"><Val value={c.leadsTotal}>{formatCount(c.leadsTotal)}</Val></Stat>
      </dl>
      {steps.length === 0 ? (
        <p className="text-[12px] text-ink-faint">No per-step numbers reported for this campaign in this range.</p>
      ) : (
        <>
        <ul className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface sm:hidden">
          {steps.map((s) => {
            const isBest = best !== null && s === best
            return (
              <li key={`${s.step}-${s.variant}`} className="px-3 py-2.5 text-[12px]">
                <div className="flex gap-2">
                  <span className="w-6 shrink-0 font-numeric text-ink-muted">
                    {s.step}
                    {s.variant}
                  </span>
                  <span className="min-w-0 flex-1 text-ink">
                    {s.subject ? s.subject : <span className="text-ink-faint">(same thread)</span>}
                    {isBest ? <span className="ml-1.5 align-middle"><Pill tone="good">best reply rate</Pill></span> : null}
                  </span>
                </div>
                <div className="mt-1 pl-8 font-numeric text-ink-muted">
                  <Val value={s.sent}>{formatCount(s.sent)}</Val> sent · <Val value={s.replied}>{formatCount(s.replied)}</Val>{' '}
                  {s.replied === 1 ? 'reply' : 'replies'} · <span className="text-ink"><Val value={s.replyRate}>{formatPct(s.replyRate)}</Val></span>
                </div>
              </li>
            )
          })}
        </ul>
        <div className="hidden overflow-x-auto rounded-card border border-line-soft bg-surface sm:block">
          <table className="w-full min-w-[520px] text-[12px]">
            <thead>
              <tr className="border-b border-line-soft text-left text-ink-faint">
                <th className="px-3 py-2 font-medium">Step</th>
                <th className="px-3 py-2 font-medium">Subject line</th>
                <th className="px-3 py-2 text-right font-medium">Sent</th>
                {trackingOn ? <th className="px-3 py-2 text-right font-medium">Opened</th> : null}
                <th className="px-3 py-2 text-right font-medium">Replies</th>
                <th className="px-3 py-2 text-right font-medium" title="Replies ÷ emails sent for this step and variant">Reply rate</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {steps.map((s) => {
                const isBest = best !== null && s === best
                return (
                  <tr key={`${s.step}-${s.variant}`}>
                    <td className="whitespace-nowrap px-3 py-2 font-numeric text-ink-muted">
                      {s.step}
                      {s.variant}
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {s.subject ? (
                        <span className={isBest ? 'font-medium' : undefined}>{s.subject}</span>
                      ) : (
                        <span className="text-ink-faint" title="Follow-ups usually reuse the thread subject">(same thread)</span>
                      )}
                      {isBest ? <span className="ml-2 align-middle"><Pill tone="good">best reply rate</Pill></span> : null}
                    </td>
                    <td className="px-3 py-2 text-right font-numeric"><Val value={s.sent}>{formatCount(s.sent)}</Val></td>
                    {trackingOn ? (
                      <td className="px-3 py-2 text-right font-numeric"><Val value={s.opened}>{formatCount(s.opened)}</Val></td>
                    ) : null}
                    <td className="px-3 py-2 text-right font-numeric"><Val value={s.replied}>{formatCount(s.replied)}</Val></td>
                    <td className="px-3 py-2 text-right font-numeric"><Val value={s.replyRate}>{formatPct(s.replyRate)}</Val></td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        </>
      )}
    </div>
  )
}

/** Minimum sends before a step can be labelled "best" — tiny samples are noise. */
export const BEST_STEP_MIN_SENT = 50

/** The step/variant with the highest reply rate among those with enough sends; null if none qualifies or there is only one. */
export function bestStep(steps: StepStat[]): StepStat | null {
  const eligible = steps.filter((s) => s.replyRate !== null && s.sent !== null && s.sent >= BEST_STEP_MIN_SENT)
  if (eligible.length < 2) return null
  const top = eligible.reduce((a, b) => ((b.replyRate as number) > (a.replyRate as number) ? b : a))
  return (top.replyRate as number) > 0 ? top : null
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-ink-faint">{label}</dt>
      <dd className="font-numeric text-ink">{children}</dd>
    </div>
  )
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 text-ink-faint transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden>
      <path d="M4 2.5 7.5 6 4 9.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

export function CampaignTable({ campaigns }: { campaigns: CampaignRow[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'status', dir: 'asc' })
  const [open, setOpen] = useState<Set<string>>(new Set())
  const [showIdle, setShowIdle] = useState(false)

  // Campaigns that sent nothing in the range are folded away by default, so
  // the table leads with what is actually running. Unknown (null) sends stay visible.
  const idle = campaigns.filter((c) => c.counts.sent === 0)
  const visible = showIdle ? campaigns : campaigns.filter((c) => c.counts.sent !== 0)
  const rows = useMemo(() => {
    if (sort.key === 'status') {
      // status first, then most sent
      return [...visible].sort(
        (a, b) =>
          (STATUS[a.status]?.rank ?? 9) - (STATUS[b.status]?.rank ?? 9) ||
          (b.counts.sent ?? -1) - (a.counts.sent ?? -1) ||
          a.name.localeCompare(b.name),
      )
    }
    return sortCampaigns(visible, sort.key, sort.dir)
  }, [visible, sort])

  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const setSortKey = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' || key === 'status' ? 'asc' : 'desc' }))

  const ariaSort = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
  const arrow = (key: SortKey) => (sort.key === key ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '')

  const active = campaigns.filter((c) => c.status === 'active').length

  return (
    <section aria-labelledby="campaigns-heading">
      <SectionHeader
        id="campaigns-heading"
        title="Campaigns"
        meta={`${campaigns.length} total · ${active} active${idle.length ? ` · ${idle.length} sent nothing in range` : ''}`}
      />
      <Card>
        {campaigns.length === 0 ? (
          <EmptyNote>No campaigns in this range.</EmptyNote>
        ) : (
          <>
            {rows.length === 0 ? <EmptyNote>None of your campaigns sent anything in this range.</EmptyNote> : null}
            {/* Desktop table */}
            <div className={`hidden overflow-x-auto ${rows.length ? 'md:block' : ''}`}>
              <table className="w-full text-[13px]" data-testid="campaign-table">
                <thead>
                  <tr className="border-b border-line text-left text-[12px] text-ink-faint">
                    <th className="py-2.5 pl-4 pr-2 font-medium" aria-sort={ariaSort('name')}>
                      <button type="button" onClick={() => setSortKey('name')} className="hover:text-ink">Campaign{arrow('name')}</button>
                    </th>
                    <th className="px-2 py-2.5 font-medium" aria-sort={ariaSort('status')}>
                      <button type="button" onClick={() => setSortKey('status')} className="hover:text-ink">Status{arrow('status')}</button>
                    </th>
                    {COLUMNS.map((col) => (
                      <th key={col.key} className="px-2 py-2.5 text-right font-medium last:pr-4" aria-sort={ariaSort(col.key)} title={col.title}>
                        <button type="button" onClick={() => setSortKey(col.key)} className="whitespace-nowrap hover:text-ink">
                          {col.label}
                          {arrow(col.key)}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((c) => {
                    const isOpen = open.has(c.id)
                    return (
                      <Fragment key={c.id}>
                        <tr className={`border-b border-line-soft ${isOpen ? 'bg-canvas/60' : 'hover:bg-canvas/60'}`}>
                          <td className="max-w-[320px] py-2.5 pl-4 pr-2">
                            <button
                              type="button"
                              onClick={() => toggle(c.id)}
                              aria-expanded={isOpen}
                              className="flex w-full items-center gap-2 text-left font-medium text-ink"
                            >
                              <Chevron open={isOpen} />
                              <span className="truncate" title={c.name}>{c.name}</span>
                            </button>
                          </td>
                          <td className="px-2 py-2.5"><StatusPill status={c.status} /></td>
                          {COLUMNS.map((col) => (
                            <td key={col.key} className="px-2 py-2.5 text-right font-numeric text-ink last:pr-4">{cellValue(c, col.key)}</td>
                          ))}
                        </tr>
                        {isOpen ? (
                          <tr className="border-b border-line-soft bg-canvas/60">
                            <td colSpan={COLUMNS.length + 2} className="px-4 pb-4 pl-9 pt-1">
                              <StepsDetail c={c} />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {/* Phone cards */}
            <ul className="divide-y divide-line-soft md:hidden">
              {rows.map((c) => {
                const isOpen = open.has(c.id)
                return (
                  <li key={c.id} className="px-4 py-3">
                    <button type="button" onClick={() => toggle(c.id)} aria-expanded={isOpen} className="flex w-full items-start gap-2 text-left">
                      <span className="mt-1"><Chevron open={isOpen} /></span>
                      <span className="min-w-0 flex-1 text-[14px] font-medium leading-snug text-ink">{c.name}</span>
                      <StatusPill status={c.status} />
                    </button>
                    <dl className="mt-2 grid grid-cols-3 gap-x-3 gap-y-2 pl-5 text-[12px]">
                      {(['contacted', 'replyRate', 'positiveRate', 'sent', 'bounceRate', 'leadsRemaining'] as SortKey[]).map((k) => {
                        const col = COLUMNS.find((x) => x.key === k)!
                        return (
                          <div key={k}>
                            <dt className="text-ink-faint">{col.label}</dt>
                            <dd className="font-numeric text-[13px] text-ink">{cellValue(c, k)}</dd>
                          </div>
                        )
                      })}
                    </dl>
                    {isOpen ? (
                      <div className="mt-3 pl-5">
                        <StepsDetail c={c} />
                      </div>
                    ) : null}
                  </li>
                )
              })}
            </ul>

            {idle.length ? (
              <button
                type="button"
                onClick={() => setShowIdle((v) => !v)}
                className="w-full border-t border-line-soft px-4 py-2.5 text-left text-[12px] font-medium text-accent hover:underline"
              >
                {showIdle ? 'Hide' : 'Show'} {idle.length} campaign{idle.length === 1 ? '' : 's'} with no sends in this range
              </button>
            ) : null}
          </>
        )}
      </Card>
      <p className="mt-2 px-1 text-[11px] text-ink-faint">
        Open a campaign for per-step results and subject lines. A dash (—) means the number was not reported by Instantly.
      </p>
    </section>
  )
}
