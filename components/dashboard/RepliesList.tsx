import type { RepliedLead } from '@/lib/dashboard/types'
import { Card, EmptyNote, Pill, SectionHeader, type PillTone } from './primitives'

const INTEREST: Record<RepliedLead['interest'], { label: string; tone: PillTone }> = {
  interested: { label: 'Interested', tone: 'good' },
  meeting_booked: { label: 'Meeting booked', tone: 'good' },
  meeting_completed: { label: 'Met', tone: 'good' },
  won: { label: 'Won', tone: 'good' },
  unlabeled: { label: 'Not labeled', tone: 'neutral' },
  out_of_office: { label: 'Out of office', tone: 'neutral' },
  wrong_person: { label: 'Wrong person', tone: 'neutral' },
  not_interested: { label: 'Not interested', tone: 'neutral' },
  lost: { label: 'Lost', tone: 'neutral' },
  no_show: { label: 'No-show', tone: 'neutral' },
}

const INTEREST_RANK: Record<RepliedLead['interest'], number> = {
  interested: 0, meeting_booked: 1, unlabeled: 2, meeting_completed: 3, won: 4,
  wrong_person: 5, out_of_office: 6, not_interested: 7, lost: 8, no_show: 3,
}

/** Waiting-on-you first: positive interest, then longest wait. */
export function sortWaiting(leads: RepliedLead[]): RepliedLead[] {
  return [...leads].sort(
    (a, b) =>
      (INTEREST_RANK[a.interest] ?? 9) - (INTEREST_RANK[b.interest] ?? 9) ||
      (b.daysWaiting ?? -1) - (a.daysWaiting ?? -1),
  )
}

function waitingLabel(days: number | null): { text: string; urgent: boolean } {
  if (days === null) return { text: 'wait unknown', urgent: false }
  if (days < 1) return { text: 'today', urgent: false }
  const d = Math.floor(days)
  return { text: `${d} day${d === 1 ? '' : 's'} waiting`, urgent: d >= 2 }
}

function LeadItem({ l }: { l: RepliedLead }) {
  const i = INTEREST[l.interest] ?? INTEREST.unlabeled
  const w = waitingLabel(l.daysWaiting)
  const who = l.name || l.email
  return (
    <li className="min-w-0 px-4 py-3 sm:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <span className="text-[14px] font-medium text-ink">{who}</span>
          {l.company ? <span className="text-[13px] text-ink-muted"> · {l.company}</span> : null}
        </div>
        <div className="flex items-center gap-2">
          <Pill tone={i.tone}>{i.label}</Pill>
          {l.awaitingOurReply ? (
            <span className={`whitespace-nowrap font-numeric text-[12px] ${w.urgent ? 'font-medium text-bad' : 'text-ink-muted'}`}>{w.text}</span>
          ) : null}
        </div>
      </div>
      <div className="mt-0.5 text-[12px] text-ink-faint">
        {l.name ? <span className="break-all">{l.email}</span> : null}
        {l.name && l.campaignName ? ' · ' : null}
        {l.campaignName ? <span>{l.campaignName}</span> : null}
      </div>
      {l.lastReplySnippet ? (
        <p className="mt-1.5 line-clamp-2 [overflow-wrap:anywhere] border-l-2 border-line pl-2.5 text-[13px] leading-relaxed text-ink-muted">{l.lastReplySnippet}</p>
      ) : null}
    </li>
  )
}

export function RepliesList({ leads }: { leads: RepliedLead[] }) {
  const waiting = sortWaiting(leads.filter((l) => l.awaitingOurReply))
  const others = [...leads.filter((l) => !l.awaitingOurReply)].sort((a, b) => (b.lastReplyAt ?? '').localeCompare(a.lastReplyAt ?? ''))
  return (
    <section className="min-w-0" aria-labelledby="replies-heading">
      <SectionHeader
        id="replies-heading"
        title="Replies waiting on you"
        meta={leads.length ? `${waiting.length} waiting · ${leads.length} replied in range` : undefined}
      />
      <Card>
        {waiting.length === 0 ? (
          <EmptyNote>{leads.length ? "You're caught up. Every reply in this range has an answer." : 'No replies in this range.'}</EmptyNote>
        ) : (
          <ul className="divide-y divide-line-soft" data-testid="waiting-list">
            {waiting.map((l) => (
              <LeadItem key={`${l.email}-${l.campaignId ?? ''}`} l={l} />
            ))}
          </ul>
        )}
        {others.length ? (
          <details className="group border-t border-line-soft">
            <summary className="cursor-pointer list-none px-4 py-2.5 text-[12px] font-medium text-accent hover:underline sm:px-5">
              <span className="group-open:hidden">Show {others.length} answered repl{others.length === 1 ? 'y' : 'ies'}</span>
              <span className="hidden group-open:inline">Hide answered replies</span>
            </summary>
            <ul className="divide-y divide-line-soft border-t border-line-soft">
              {others.map((l) => (
                <LeadItem key={`${l.email}-${l.campaignId ?? ''}`} l={l} />
              ))}
            </ul>
          </details>
        ) : null}
      </Card>
    </section>
  )
}
