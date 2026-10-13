'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { LeadListRow } from '@/lib/leads/queries'
import type { SortKey } from '@/lib/leads/filters'
import { STAGE_LABELS } from '@/lib/leads/filters'
import { STAGES } from '@/lib/leads/types'
import { StagePill, VerificationPill, ResearchPill, ScorePill, place } from './pills'
import { BulkBar } from './BulkBar'
import { InlineEditCell } from '@/components/edit/InlineEditCell'

const STAGE_OPTIONS = STAGES.map((s) => ({ value: s, label: STAGE_LABELS[s] }))

export interface SortLink {
  key: SortKey
  href: string
  /** set when this column is the current sort */
  dir?: 'asc' | 'desc'
}

const COLS: { key: SortKey | null; label: string; className?: string }[] = [
  { key: 'name', label: 'Lead' },
  { key: 'state', label: 'Place' },
  { key: 'stage', label: 'Stage' },
  { key: null, label: 'Score' },
  { key: 'email', label: 'Email' },
  { key: 'verification', label: 'Verified' },
  { key: 'campaign', label: 'Campaign' },
  { key: 'updated', label: 'Updated', className: 'text-right' },
]

/**
 * The leads list with bulk select. Desktop: a sortable table. Phone: one row
 * per lead, same checkboxes, same actions. Dates arrive pre-formatted from the
 * server (updatedLabels) so the server's timezone decides them.
 */
export function LeadsTable({
  rows,
  sortLinks,
  updatedLabels,
  showResearch = false,
}: {
  rows: LeadListRow[]
  sortLinks: SortLink[]
  updatedLabels: Record<number, string>
  showResearch?: boolean
}) {
  const [sel, setSel] = useState<Set<number>>(new Set())
  const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id))
  const selected = useMemo(() => {
    const picked = rows.filter((r) => sel.has(r.id))
    return { companyIds: picked.map((r) => r.id), unverifiedContactIds: picked.flatMap((r) => r.unverified_ids) }
  }, [rows, sel])

  const toggle = (id: number) =>
    setSel((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const toggleAll = () => setSel(allOn ? new Set() : new Set(rows.map((r) => r.id)))
  const link = (k: SortKey) => sortLinks.find((s) => s.key === k)

  return (
    <div>
      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        <table className="hidden w-full text-left text-[13px] md:table" data-testid="leads-table">
          <thead className="border-b border-line bg-canvas/60 text-[11px] uppercase tracking-[0.05em] text-ink-faint">
            <tr>
              <th className="w-9 py-2 pl-3">
                <input type="checkbox" aria-label="Select all on this page" checked={allOn} onChange={toggleAll} className="accent-accent" />
              </th>
              {COLS.map((c) => {
                const s = c.key ? link(c.key) : undefined
                return (
                  <th key={c.label} className={`px-3 py-2 font-medium ${c.className ?? ''}`} aria-sort={s?.dir ? (s.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                    {s ? (
                      <Link href={s.href} prefetch={false} className={`hover:text-ink ${s.dir ? 'text-ink' : ''}`}>
                        {c.label}
                        {s.dir ? <span aria-hidden> {s.dir === 'asc' ? '↑' : '↓'}</span> : null}
                      </Link>
                    ) : (
                      c.label
                    )}
                  </th>
                )
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-line-soft">
            {rows.map((r) => (
              <tr key={r.id} className={sel.has(r.id) ? 'bg-accent-soft/60' : 'hover:bg-canvas/70'}>
                <td className="py-2 pl-3 align-top">
                  <input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="mt-0.5 accent-accent" />
                </td>
                <td className="max-w-[260px] px-3 py-2 align-top">
                  <div className="flex items-baseline gap-2">
                    <InlineEditCell type="company" id={r.id} field="name" value={r.name} label={`Name for ${r.name}`} className="font-medium text-ink" />
                    <Link href={`/leads/${r.id}`} prefetch={false} className="text-[11px] text-ink-faint hover:text-accent">
                      Open →
                    </Link>
                  </div>
                  <div className="truncate text-[12px] text-ink-faint" title={[r.website_domain, r.owner_name].filter(Boolean).join(' · ') || undefined}>
                    {[r.website_domain, r.owner_name].filter(Boolean).join(' · ') || <span className="text-unavailable">No site or owner yet</span>}
                  </div>
                  {showResearch ? (
                    <div className="mt-1">
                      <ResearchPill status={r.research_status} />
                    </div>
                  ) : null}
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top text-ink-muted">{place(r.city, r.state) ?? <Dash />}</td>
                <td className="px-3 py-2 align-top">
                  <InlineEditCell type="company" id={r.id} field="stage" value={r.stage} label={`Stage for ${r.name}`} options={STAGE_OPTIONS} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 align-top">
                  {r.score != null ? (
                    <ScorePill score={r.score} thresholdLabel={r.score_threshold} title={r.score_model ?? undefined} />
                  ) : (
                    <Dash />
                  )}
                </td>
                <td className="max-w-[220px] truncate px-3 py-2 align-top text-ink-muted" title={r.primary_email ?? undefined}>
                  {r.primary_email ?? <Dash />}
                  {r.contact_count > 1 ? <span className="ml-1 text-[11px] text-ink-faint tabular-nums">+{r.contact_count - 1}</span> : null}
                </td>
                <td className="px-3 py-2 align-top">{r.primary_verification ? <VerificationPill status={r.primary_verification} /> : <Dash />}</td>
                <td className="max-w-[180px] truncate px-3 py-2 align-top text-ink-muted" title={r.campaign_name ?? undefined}>{r.campaign_name ?? <Dash />}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right align-top tabular-nums text-ink-faint">{updatedLabels[r.id] ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <ul className="divide-y divide-line-soft md:hidden" data-testid="leads-list">
          <li className="flex items-center gap-3 bg-canvas/60 px-3 py-2 text-[12px] text-ink-faint">
            <input type="checkbox" aria-label="Select all on this page" checked={allOn} onChange={toggleAll} className="accent-accent" />
            <span>Select all</span>
          </li>
          {rows.map((r) => (
            <li key={r.id} className={`flex gap-3 px-3 py-2.5 ${sel.has(r.id) ? 'bg-accent-soft/60' : ''}`}>
              <input type="checkbox" aria-label={`Select ${r.name}`} checked={sel.has(r.id)} onChange={() => toggle(r.id)} className="mt-1 accent-accent" />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline justify-between gap-2">
                  <Link href={`/leads/${r.id}`} prefetch={false} className="truncate text-[14px] font-medium text-ink">
                    {r.name}
                  </Link>
                  <span className="shrink-0 text-[11px] tabular-nums text-ink-faint">{place(r.city, r.state) ?? ''}</span>
                </div>
                <div className="truncate text-[12px] text-ink-muted" title={r.primary_email ?? r.website_domain ?? undefined}>{r.primary_email ?? r.website_domain ?? 'No email yet'}</div>
                <div className="mt-1 flex flex-wrap gap-1">
                  <StagePill stage={r.stage} />
                  {r.score != null ? <ScorePill score={r.score} thresholdLabel={r.score_threshold} title={r.score_model ?? undefined} /> : null}
                  {r.primary_verification ? <VerificationPill status={r.primary_verification} /> : null}
                  {showResearch ? <ResearchPill status={r.research_status} /> : null}
                </div>
                {updatedLabels[r.id] ? <div className="mt-1 text-[11px] tabular-nums text-ink-faint">Updated {updatedLabels[r.id]}</div> : null}
              </div>
            </li>
          ))}
        </ul>
      </div>
      <BulkBar selected={selected} onDone={() => setSel(new Set())} />
    </div>
  )
}

function Dash() {
  return <span className="text-unavailable">—</span>
}
