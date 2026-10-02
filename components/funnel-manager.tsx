'use client'

import { useState } from 'react'
import { COPY } from '@/lib/copy'
import { formatCount, formatRate } from '@/lib/format'
import { exportToCsv } from '@/lib/csv'

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

export function FunnelTable({ rows, label }: { rows: FunnelRow[]; label: string }) {
  const [sortField, setSortField] = useState<'name' | 'contacted' | 'replied' | 'positive' | 'reply_rate' | 'positive_rate'>('name')
  const [sortDirection, setSortDirection] = useState<'asc' | 'desc'>('asc')

  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-faint">{COPY.funnel.noRows(label)}</p>
  }

  const sortedRows = [...rows].sort((a, b) => {
    let aVal: string | number = (a.campaign_name ?? a.idea_name)
    let bVal: string | number = (b.campaign_name ?? b.idea_name)

    if (sortField !== 'name') {
      aVal = a[sortField] ?? (sortDirection === 'asc' ? Infinity : -Infinity)
      bVal = b[sortField] ?? (sortDirection === 'asc' ? Infinity : -Infinity)
    }

    const cmp = typeof aVal === 'string'
      ? aVal.localeCompare(bVal as string)
      : (aVal as number) - (bVal as number)
    return sortDirection === 'asc' ? cmp : -cmp
  })

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
          className="text-[11px] text-ink-muted hover:text-ink underline underline-offset-2"
        >
          Export CSV
        </button>
        <div className="flex items-center gap-2">
          <select
          aria-label={`Sort ${label.toLowerCase()} funnel`}
          value={sortField}
          onChange={e => setSortField(e.target.value as typeof sortField)}
          className="h-8 rounded border border-line bg-surface px-2 text-ink"
        >
          <option value="name">Name</option>
          <option value="contacted">Contacted</option>
          <option value="replied">Replied</option>
          <option value="positive">Opportunities</option>
          <option value="reply_rate">Reply %</option>
          <option value="positive_rate">Opportunity %</option>
        </select>
        <button
          type="button"
          onClick={() => setSortDirection(d => d === 'asc' ? 'desc' : 'asc')}
          className="h-8 rounded border border-line px-2.5 text-ink hover:bg-line-soft"
          aria-label={`Sort ${sortDirection === 'asc' ? 'descending' : 'ascending'}`}
        >
            {sortDirection === 'asc' ? 'Ascending' : 'Descending'}
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
