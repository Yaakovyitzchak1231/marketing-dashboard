'use client'

import { useState } from 'react'
import type { SequencePlan } from '@/lib/dashboard/types'
import { formatCount } from './format'
import { Pill } from './primitives'

/** "Oct 13" from YYYY-MM-DD (calendar date, no timezone shift). */
export function shortDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })
}

const DAYS_SHOWN = 14

/** Every step of the sequence, sent or upcoming, with dates; then the days emails went out. */
export function SequencePlanView({ plan }: { plan: SequencePlan }) {
  const [allDays, setAllDays] = useState(false)
  const days = plan.days ? [...plan.days].reverse() : null
  const shownDays = days && !allDays ? days.slice(0, DAYS_SHOWN) : days
  return (
    <div className="space-y-3">
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-ink-muted">Sequence</h3>
        <ol className="divide-y divide-line-soft rounded-card border border-line-soft bg-surface text-xs">
          {plan.steps.map((s) => (
            <li key={s.step} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2">
              <span className="w-12 shrink-0 font-numeric text-ink-muted">Step {s.step}</span>
              <span className="w-14 shrink-0 font-numeric text-ink-faint" title="Days after a lead's first email">
                Day {s.dayOffset}
              </span>
              <span className="min-w-0 flex-1 text-ink">
                {s.subject ? s.subject : <span className="text-ink-faint">(same thread)</span>}
              </span>
              {s.status === 'sent' ? (
                <Pill tone="good">{formatCount(s.sent)} sent</Pill>
              ) : (
                <Pill tone="neutral">Upcoming</Pill>
              )}
              <span className="font-numeric text-ink-muted">
                {s.status === 'sent' && s.firstDate ? <>First sent {shortDay(s.firstDate)}</> : null}
                {s.status !== 'sent' && s.firstDate ? <>Scheduled from {shortDay(s.firstDate)}</> : null}
                {s.nextDate ? <>{s.firstDate ? ' · ' : ''}next {shortDay(s.nextDate)} (scheduled)</> : null}
                {!s.firstDate && !s.nextDate ? <span className="text-ink-faint">No date yet</span> : null}
              </span>
            </li>
          ))}
        </ol>
        <p className="mt-1 text-2xs text-ink-faint">
          Scheduled dates count each step&apos;s wait from the day a lead got its first email. Instantly can shift a send to fit the sending schedule.
        </p>
      </div>
      <div>
        <h3 className="mb-1.5 text-xs font-medium text-ink-muted">Send days (last 60 days)</h3>
        {days === null ? (
          <p className="text-xs text-ink-faint">Send dates are not available right now.</p>
        ) : days.length === 0 ? (
          <p className="text-xs text-ink-faint">No emails sent in the last 60 days.</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line-soft bg-surface">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-line-soft text-left text-ink-faint">
                  <th className="px-3 py-2 font-medium">Date</th>
                  <th className="px-3 py-2 text-right font-medium">Emails sent</th>
                  <th className="px-3 py-2 text-right font-medium" title="Leads who got their first email that day">New leads contacted</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {(shownDays ?? []).map((d) => (
                  <tr key={d.date}>
                    <td className="whitespace-nowrap px-3 py-1.5 text-ink">{shortDay(d.date)}</td>
                    <td className="px-3 py-1.5 text-right font-numeric">{formatCount(d.sent)}</td>
                    <td className="px-3 py-1.5 text-right font-numeric">{formatCount(d.newLeads)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {days.length > DAYS_SHOWN ? (
              <button type="button" className="w-full border-t border-line-soft px-3 py-1.5 text-left text-xs text-accent hover:underline" onClick={() => setAllDays((v) => !v)}>
                {allDays ? 'Show fewer days' : `Show all ${days.length} days`}
              </button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
