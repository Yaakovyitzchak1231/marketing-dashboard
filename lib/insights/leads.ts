/**
 * Replies waiting on you: interested / meeting leads whose latest reply is
 * newer than our last email to them (RepliedLead.awaitingOurReply), oldest first.
 */
import type { RepliedLead } from '@/lib/dashboard/types'
import { FOLLOWUP_CRITICAL_DAYS, FOLLOWUP_WARN_DAYS, MAX_LEAD_CARDS } from './thresholds'
import { days, num } from './stats'
import { RULE_IMPACT, mag, type InsightInput, type RankedInsight } from './types'
import { localDate, q, shortDate } from './util'

/** Labels that mean "a human wants to talk": these must never sit unanswered. */
export const HOT_INTERESTS: ReadonlySet<RepliedLead['interest']> = new Set(['interested', 'meeting_booked', 'meeting_completed'])

const INTEREST_WORDS: Record<RepliedLead['interest'], string> = {
  interested: 'interested',
  meeting_booked: 'meeting booked',
  meeting_completed: 'meeting completed',
  won: 'won',
  not_interested: 'not interested',
  out_of_office: 'out of office',
  wrong_person: 'wrong person',
  lost: 'lost',
  no_show: 'no-show',
  unlabeled: 'not labeled yet',
}

/** Days waiting: the data layer's figure, else generatedAt - lastReplyAt, else null. */
export function waitingDays(l: RepliedLead, generatedAt: string): number | null {
  if (l.daysWaiting != null && Number.isFinite(l.daysWaiting) && l.daysWaiting >= 0) return l.daysWaiting
  if (!l.lastReplyAt) return null
  const a = Date.parse(l.lastReplyAt)
  const b = Date.parse(generatedAt)
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null
  return (b - a) / 86_400_000
}

function who(l: RepliedLead): string {
  const name = l.name?.trim() || l.email
  return l.company?.trim() ? `${name} at ${l.company.trim()}` : name
}

function firstName(l: RepliedLead): string {
  return l.name?.trim().split(/\s+/)[0] || l.email
}

function snippet(s: string | null): string {
  if (!s) return ''
  const t = s.replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > 140 ? `${t.slice(0, 137).trimEnd()}…` : t
}

export function leadInsights(d: InsightInput): RankedInsight[] {
  const out: RankedInsight[] = []
  const waiting = d.repliedLeads
    .filter((l) => l.awaitingOurReply)
    .map((l) => ({ l, w: waitingDays(l, d.generatedAt) }))

  const hot = waiting
    .filter(({ l }) => HOT_INTERESTS.has(l.interest))
    // Oldest first; unknown wait after known; then email for determinism.
    .sort((a, b) => (b.w ?? -1) - (a.w ?? -1) || a.l.email.localeCompare(b.l.email))

  for (const { l, w } of hot.slice(0, MAX_LEAD_CARDS)) {
    const sev = w != null && w >= FOLLOWUP_CRITICAL_DAYS ? 'critical' : w != null && w >= FOLLOWUP_WARN_DAYS ? 'warning' : 'opportunity'
    const when = l.lastReplyAt ? localDate(l.lastReplyAt, d.range.timezone) : null
    const snip = snippet(l.lastReplySnippet)
    out.push({
      id: `lead-waiting:${l.email}`,
      severity: sev,
      title: `Reply to ${who(l)}${w != null ? `, waiting ${days(w)}` : ''}`,
      detail:
        `Marked "${INTEREST_WORDS[l.interest]}" in Instantly` +
        (l.campaignName ? ` (${q(l.campaignName)})` : '') +
        (when ? `. Replied ${shortDate(when)}` : '. Reply time not reported') +
        (snip ? `: “${snip}”` : '') +
        '. Our last email to them is older than their reply.',
      action:
        l.interest === 'meeting_booked'
          ? `Confirm the meeting time with ${firstName(l)} today.`
          : l.interest === 'meeting_completed'
            ? `Send ${firstName(l)} the follow-up from your meeting today.`
            : `Reply to ${firstName(l)} today and offer two specific call times.`,
      metric: w != null ? { label: 'Waiting', value: days(w) } : undefined,
      entity: { kind: 'lead', id: l.email, name: l.name?.trim() || l.email },
      impact: RULE_IMPACT.leadWaiting + mag((w ?? 0) * 5),
    })
  }

  const rest = hot.slice(MAX_LEAD_CARDS)
  if (rest.length) {
    const oldest = rest[0].w
    out.push({
      id: 'leads-waiting-more',
      severity: oldest != null && oldest >= FOLLOWUP_CRITICAL_DAYS ? 'critical' : 'warning',
      title: `${rest.length} more interested lead${rest.length === 1 ? ' is' : 's are'} waiting on a reply`,
      detail: rest.slice(0, 8).map(({ l, w }) => `${who(l)}${w != null ? ` (${days(w)})` : ''}`).join('; ') + (rest.length > 8 ? `; and ${rest.length - 8} more` : '') + '.',
      action: 'Work through them oldest first in Instantly Unibox today.',
      impact: RULE_IMPACT.leadWaiting - 50 + mag(rest.length),
    })
  }

  const unlabeled = waiting.filter(({ l }) => l.interest === 'unlabeled')
  if (unlabeled.length) {
    out.push({
      id: 'replies-unlabeled',
      severity: 'opportunity',
      title: `${num(unlabeled.length)} repl${unlabeled.length === 1 ? 'y is' : 'ies are'} unlabeled and unanswered`,
      detail:
        unlabeled
          .sort((a, b) => (b.w ?? -1) - (a.w ?? -1) || a.l.email.localeCompare(b.l.email))
          .slice(0, 5)
          .map(({ l, w }) => `${who(l)}${w != null ? ` (${days(w)})` : ''}`)
          .join('; ') + (unlabeled.length > 5 ? `; and ${unlabeled.length - 5} more` : '') +
        '. Without a label they never show up as interested here.',
      action: 'Read them in Instantly Unibox and label each one (interested, not interested, out of office) so the hot ones surface.',
      impact: RULE_IMPACT.unlabeledWaiting + mag(unlabeled.length),
    })
  }

  return out
}
