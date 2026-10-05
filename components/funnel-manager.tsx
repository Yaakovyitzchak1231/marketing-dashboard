'use client'

import { useState } from 'react'
import { COPY } from '@/lib/copy'
import { formatCount, formatRate } from '@/lib/format'
import { exportToCsv } from '@/lib/csv'
import { compareByMetric, compareByName } from '@/lib/sort'

export type FunnelRow = {
  campaign_id?: string
  campaign_name?: string
  idea_id?: string
  idea_name: string
  contacted: number | null
  replied: number | null
  positive: number | null
  meetings: number | null
  customers: number | null
  reply_rate: number | null
  positive_rate: number | null
  meeting_rate: number | null
  close_rate: number | null
}

/**
 * The sort options, keyed on real `FunnelRow` field names rather than display
 * labels, so the comparator reads a field it can type and an unknown option
 * value can be rejected instead of cast into the sort state.
 */
const FUNNEL_SORT_OPTIONS = [
  { value: 'name', label: 'Name' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'replied', label: 'Replied' },
  { value: 'positive', label: 'Opportunities' },
  { value: 'reply_rate', label: 'Reply %' },
  { value: 'positive_rate', label: 'Opportunity %' },
] as const

type FunnelSortKey = (typeof FUNNEL_SORT_OPTIONS)[number]['value']

function isFunnelSortKey(value: string): value is FunnelSortKey {
  return FUNNEL_SORT_OPTIONS.some((option) => option.value === value)
}

export function FunnelTable({ rows, label }: { rows: FunnelRow[]; label: string }) {
  const [sortField, setSortField] = useState<FunnelSortKey>('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')

  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-faint">{COPY.funnel.noRows(label)}</p>
  }
  const rowLabel = (row: FunnelRow) => row.campaign_name ?? row.idea_name
  const sortedRows = [...rows].sort((a, b) =>
    sortField === 'name'
      ? compareByName(a, b, sortDirection, rowLabel)
      // Meetings and customers are structurally null here -- no collector ever
      // wrote them -- so they are the case this rule exists for. A null stage
      // must sink, not lead a descending sort.
      : compareByMetric(a, b, sortField, sortDirection, rowLabel),
  )

  const handleExportFunnel = () => {
    const headers = ['Name', 'Contacted', 'Replied', 'Opportunities', 'Meetings', 'Customers', 'Reply Rate', 'Opportunity Rate']
    const data = sortedRows.map(r => [
      r.campaign_name ?? r.idea_name,
      r.contacted,
      r.replied,
      r.positive,
      r.meetings,
      r.customers,
      r.reply_rate,
      r.positive_rate
    ])
    exportToCsv(`funnel_${label.toLowerCase()}`, headers, data)
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-2 text-[12px]">
        <button
          type="button"
          onClick={handleExportFunnel}
          className="text-[11px] text-ink-muted underline-offset-2 hover:text-ink hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
        >
          Export visible CSV
        </button>
        <div className="flex items-center gap-2">
          <select
            aria-label={COPY.funnel.sortBy(label)}
            value={sortField}
            onChange={e => {
              const next = e.target.value
              if (isFunnelSortKey(next)) setSortField(next)
            }}
            className="h-8 rounded border border-line bg-surface px-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
          >
            {FUNNEL_SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {/* The visible text IS the accessible name. An aria-label naming the
              ACTION ("Sort descending") on a button that reads "Ascending"
              contradicts the screen for anyone not reading it visually, which is
              WCAG 2.5.3. The action lives in title, where it is still available
              and cannot misname the control. */}
          <button
            type="button"
            onClick={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')}
            className="h-8 rounded border border-line px-2.5 text-ink hover:bg-line-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
            title={COPY.campaigns.sortDirectionAction(sortDirection)}
          >
            {sortDirection === 'asc' ? COPY.campaigns.sortAscending : COPY.campaigns.sortDescending}
          </button>
        </div>
      </div>
      <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-card">
        <table className="w-full min-w-[760px] text-[13px]">
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
              <th className="px-4 py-2 font-medium">{label}</th>
              <th className="px-4 py-2 text-right font-medium">Contacted</th>
              <th className="px-4 py-2 text-right font-medium">Replied</th>
              <th className="px-4 py-2 text-right font-medium">Opportunities</th>
              <th className="px-4 py-2 text-right font-medium">Meetings</th>
              <th className="px-4 py-2 text-right font-medium">Customers</th>
              <th className="px-4 py-2 text-right font-medium">Reply %</th>
              <th className="px-4 py-2 text-right font-medium">Opportunity %</th>
            </tr>
          </thead>
          <tbody>
            {sortedRows.map((r, i) => (
              <tr key={i} className="border-b border-line last:border-0">
                <td className="px-4 py-2 text-ink">{r.campaign_name ?? r.idea_name}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.contacted)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.replied)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.positive)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.meetings)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.customers)}</td>
                {/* Rates are formatted in lib/format.ts; never recomputed with * 100 here. */}
                <td className="px-4 py-2 text-right tabular-nums text-ink">{formatRate(r.reply_rate)}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">{formatRate(r.positive_rate)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
