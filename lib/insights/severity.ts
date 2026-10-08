import type { InsightSeverity } from '@/lib/dashboard/types'

/** Display order, most urgent first. */
export const SEVERITY_ORDER: readonly InsightSeverity[] = ['critical', 'warning', 'opportunity', 'win']

export function severityRank(s: InsightSeverity): number {
  const i = SEVERITY_ORDER.indexOf(s)
  return i === -1 ? SEVERITY_ORDER.length : i
}

/** Short label for a severity chip in the UI. */
export function severityLabel(s: InsightSeverity): string {
  switch (s) {
    case 'critical': return 'Act now'
    case 'warning': return 'Needs attention'
    case 'opportunity': return 'Opportunity'
    case 'win': return 'Working'
    default: return 'Note'
  }
}
