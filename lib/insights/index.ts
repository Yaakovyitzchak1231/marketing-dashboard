/**
 * The insights engine: turns already-fetched Instantly data into a ranked list
 * of plain-language "what to do next" callouts. Pure and deterministic: no I/O,
 * no clock (the "now" is DashboardData.generatedAt), no randomness.
 *
 * Every number in a callout comes from the data passed in. The only other
 * numbers are the named thresholds in ./thresholds.ts.
 *
 * Order: critical, warning, opportunity, win; inside a band by impact
 * (RULE_IMPACT base per rule + the size of the effect), then by id.
 */
import type { AccountHealth, DashboardData, Insight, InsightSeverity, SenderAccount } from '@/lib/dashboard/types'
import { classifyAccountHealth as classify, deliverabilityInsights } from './accounts'
import { campaignInsights } from './campaigns'
import { leadInsights } from './leads'
import { stepInsights } from './steps'
import { trendInsights } from './trends'
import type { InsightInput, RankedInsight } from './types'
import { severityRank } from './severity'

export { SEVERITY_ORDER, severityLabel, severityRank } from './severity'

/** Pure: computes plain-language insights from already-fetched data. No I/O. */
export function computeInsights(data: Omit<DashboardData, 'insights'>): Insight[] {
  if (!data || !data.configured) return []
  if (!hasAnyData(data)) return []

  const all: RankedInsight[] = [
    ...leadInsights(data),
    ...deliverabilityInsights(data),
    ...campaignInsights(data),
    ...stepInsights(data),
    ...trendInsights(data),
  ]

  // Unique ids (first one wins; rules are built to be unique, this is a guard).
  const seen = new Set<string>()
  const unique = all.filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))

  unique.sort(compareInsights)
  addTrackingNote(data, unique)
  return unique.map(({ impact: _impact, ...rest }) => stripUndefined(rest))
}

/** Pure: classifies one sending account. The data layer calls this when mapping accounts. */
export function classifyAccountHealth(
  a: Omit<SenderAccount, 'health' | 'healthReason'>,
): { health: AccountHealth; healthReason: string } {
  return classify(a)
}

/* ---------- internals ---------- */


function compareInsights(a: RankedInsight, b: RankedInsight): number {
  return severityRank(a.severity) - severityRank(b.severity) || b.impact - a.impact || a.id.localeCompare(b.id)
}

function hasAnyData(d: InsightInput): boolean {
  const c = d.totals?.counts
  const anyTotal = c != null && Object.values(c).some((v) => v != null && v !== 0)
  return anyTotal || d.campaigns.length > 0 || d.accounts.length > 0 || d.repliedLeads.length > 0 || d.daily.length > 0
}

const TRACKING_NOTE = ' Open tracking is off, so opens are not measured (not a 0% open rate); replies are the signal.'

/** Say "open tracking is off" once, inside the most relevant card. Never as its own problem card. */
function addTrackingNote(d: InsightInput, list: RankedInsight[]): void {
  const off = d.campaigns.some((c) => c.openTracking === false) ||
    (d.campaigns.length > 0 && d.campaigns.every((c) => c.openTracking !== true) && d.totals.counts.opened == null)
  if (!off || !list.length) return
  // Reply-rate cards first: that is where someone would otherwise look for an open rate.
  const prefs = [
    'campaign-vs-history', 'campaign-gap', 'campaign-best', 'trend-reply', 'campaign-zero-replies',
    'step-mix', 'subject-best', 'variant-winner', 'campaigns-stopped-winners', 'campaign',
  ]
  let target: RankedInsight | undefined
  for (const pre of prefs) {
    target = list.find((i) => i.id.startsWith(pre))
    if (target) break
  }
  target = target ?? list[0]
  target.detail = target.detail.trimEnd() + TRACKING_NOTE
}

function stripUndefined<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k]
  return out as T
}

export type { InsightSeverity }
