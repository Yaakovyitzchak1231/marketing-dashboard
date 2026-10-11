/**
 * Campaign sequence plan: every step of a campaign's sequence (including steps
 * that have not sent yet), when each step goes out, and the days emails went out
 * with the number of new leads contacted that day.
 *
 * Pure: inputs are the Instantly campaign (its sequence and step delays), the
 * per-step results already mapped by stepStats, and the campaign's own daily
 * analytics rows. No I/O here.
 *
 * Dates for steps are estimates. Instantly's `delay` on a step is the wait before
 * the NEXT step, so step N goes out (delay 1 + … + delay N-1) days after a lead's
 * first email. A lead's first email day is a day with new leads contacted. Instantly
 * can shift a send to fit the campaign's sending schedule, so these read as "scheduled".
 */
import type { ApiCampaign, ApiDailyRow } from '@/lib/instantly/types'
import type { PlannedStep, SendDay, SequencePlan, StepStat } from '@/lib/dashboard/types'
export type { PlannedStep, SendDay, SequencePlan }
import { addDays } from '@/lib/dashboard/dates'

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** A step delay in days. Instantly reports `delay` plus an optional `delay_unit` (days by default). */
export function delayDays(step: { delay?: unknown; delay_unit?: unknown } | undefined): number {
  if (!step) return 0
  const d = num(step.delay)
  const unit = typeof step.delay_unit === 'string' ? step.delay_unit.toLowerCase() : 'days'
  if (unit.startsWith('minute')) return d / 1440
  if (unit.startsWith('hour')) return d / 24
  return d
}

/** Days emails went out, with new leads contacted per day. Days with nothing sent and no new leads are dropped. */
export function sendDays(rows: ApiDailyRow[] | null | undefined): SendDay[] | null {
  if (!Array.isArray(rows)) return null
  const byDate = new Map<string, SendDay>()
  for (const r of rows) {
    if (!r || typeof r.date !== 'string') continue
    const date = r.date.slice(0, 10)
    const d = byDate.get(date) ?? { date, sent: 0, newLeads: 0 }
    d.sent += num(r.sent)
    d.newLeads += num(r.new_leads_contacted)
    byDate.set(date, d)
  }
  return [...byDate.values()].filter((d) => d.sent > 0 || d.newLeads > 0).sort((a, b) => a.date.localeCompare(b.date))
}

export function sequencePlan(
  campaign: ApiCampaign | undefined,
  stats: StepStat[],
  daily: ApiDailyRow[] | null | undefined,
  today: string,
): SequencePlan {
  const days = sendDays(daily)
  const seq = campaign?.sequences?.[0]?.steps ?? []
  // Steps can show up in the results even when the sequence wasn't listed.
  const maxStatStep = stats.reduce((m, s) => Math.max(m, s.step), 0)
  const count = Math.max(seq.length, maxStatStep)
  const firstDays = (days ?? []).filter((d) => d.newLeads > 0).map((d) => d.date)
  const steps: PlannedStep[] = []
  let offset = 0
  for (let i = 0; i < count; i++) {
    if (i > 0) offset += delayDays(seq[i - 1] as { delay?: unknown; delay_unit?: unknown } | undefined)
    const s = seq[i]
    const enabled = (s?.variants ?? []).filter((v) => !v?.v_disabled)
    const subj = enabled[0]?.subject ?? s?.variants?.[0]?.subject ?? null
    const rows = stats.filter((x) => x.step === i + 1)
    const reported = rows.filter((x) => x.sent !== null)
    const sent = reported.length ? reported.reduce((a, x) => a + (x.sent as number), 0) : stats.length ? 0 : null
    const whole = Math.round(offset)
    const dates = firstDays.map((d) => addDays(d, whole))
    steps.push({
      step: i + 1,
      subject: typeof subj === 'string' && subj.trim() ? subj : null,
      variants: Math.max(enabled.length, rows.length, s ? 1 : 0),
      dayOffset: whole,
      sent,
      status: sent !== null && sent > 0 ? 'sent' : 'upcoming',
      firstDate: dates[0] ?? null,
      nextDate: dates.find((d) => d >= today) ?? null,
    })
  }
  return { steps, days }
}
