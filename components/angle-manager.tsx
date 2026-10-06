'use client'

import { useState } from 'react'
import { useApi } from '@/components/use-api'
import { formatRate } from '@/lib/format'
import { PERFORMANCE_RANGE_LABEL } from '@/lib/range'
import { exportToCsv } from '@/lib/csv'
import { compareByMetric, compareByName } from '@/lib/sort'
import { COPY } from '@/lib/copy'
import { ArtifactProvenance } from '@/components/artifact-provenance'

type Angle = {
  id: string
  name: string
  description: string | null
  campaign_id: string | null
  variant_label: string | null
  campaigns?: { name: string } | null
}

type PerfRow = {
  angle_id: string
  angle_name: string
  campaign_name: string | null
  emails_sent: number | null
  unique_replies: number | null
  human_reply_rate: number | null
  attributed: boolean
}

export function AngleManager({
  initialAngles,
  initialPerformance,
  campaigns,
  ownerEmail,
}: {
  initialAngles: Angle[]
  initialPerformance: PerfRow[]
  campaigns: { id: string; name: string }[]
  ownerEmail?: string
}) {
  const api = useApi()
  const [angles, setAngles] = useState<Angle[]>(initialAngles)
  const [perf] = useState<PerfRow[]>(initialPerformance)
  const [name, setName] = useState('')
  const [campaignId, setCampaignId] = useState('')
  const [variant, setVariant] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [perfSort, setPerfSort] = useState<'name' | 'human_reply_rate'>('human_reply_rate')
  const [perfDirection, setPerfDirection] = useState<'asc' | 'desc'>('desc')
  const [angleQuery, setAngleQuery] = useState('')

  const perfLabel = (row: PerfRow) => row.angle_name
  const sortedPerf = [...perf].sort((a, b) =>
    perfSort === 'name'
      ? compareByName(a, b, perfDirection, perfLabel)
      // A reply rate Instantly never reported is absent, so it sinks in both
      // directions rather than floating to the top of a descending sort.
      : compareByMetric(a, b, 'human_reply_rate', perfDirection, perfLabel),
  )

  const filteredAngles = angles.filter(a =>
    !angleQuery ||
    a.name.toLowerCase().includes(angleQuery.toLowerCase()) ||
    a.campaigns?.name.toLowerCase().includes(angleQuery.toLowerCase())
  )

  const refresh = async () => setAngles(await api('/api/angles'))

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api('/api/angles', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          campaign_id: campaignId || null,
          variant_label: variant.trim() || null,
        }),
      })
      setName('')
      setVariant('')
      setCampaignId('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create angle')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this angle?')) return
    try {
      await api(`/api/angles/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete angle')
    }
  }

  const handleExportPerformance = () => {
    const headers = ['Angle', 'Campaign', 'Sent', 'Unique Replies', 'Human Reply Rate']
    const data = sortedPerf.map(p => [
      p.angle_name,
      p.campaign_name,
      p.emails_sent,
      p.unique_replies,
      p.human_reply_rate
    ])
    exportToCsv('angles_performance', headers, data)
  }

  return (
    <div className="space-y-8">
      {error && (
        <div role="alert" className="border-l-2 border-warn px-3 py-2 text-[12px] text-ink-muted">{error}</div>
      )}

      <section className="rounded-card border border-line bg-surface px-5 py-4">
        <h2 className="text-[12px] font-medium text-ink">New angle</h2>
        <form onSubmit={create} className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4 sm:items-end">
          <label className="sm:col-span-2">
            <span className="mb-1 block text-[11px] text-ink-muted">Name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Penalty-fear opener"
              className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-ink-muted">Campaign</span>
            <select
              value={campaignId}
              onChange={e => setCampaignId(e.target.value)}
              className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            >
              <option value="">None</option>
              {campaigns.map(c => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className="mb-1 block text-[11px] text-ink-muted">Variant label</span>
            <input
              value={variant}
              onChange={e => setVariant(e.target.value)}
              placeholder="A / B"
              className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded bg-ink px-4 py-2 text-[13px] text-white disabled:opacity-40 sm:col-start-4"
          >
            {saving ? 'Saving…' : 'Add angle'}
          </button>
        </form>
        <p className="mt-2 text-[11px] text-ink-faint">
          A campaign with one angle gets that campaign&apos;s metrics. With two or more angles,
          metrics cannot be split honestly and stay unattributed.
        </p>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            Human-reply rate — {PERFORMANCE_RANGE_LABEL}
          </h2>
          {perf.length > 0 && (
            <div className="flex items-center gap-2 text-[12px]">
              <button
                type="button"
                onClick={handleExportPerformance}
                className="text-[11px] text-ink-muted hover:text-ink underline underline-offset-2 mr-2"
              >
                Export visible CSV
              </button>
              <select
                aria-label="Sort performance"
                value={perfSort}
                onChange={e => {
                  const next = e.target.value
                  if (next === 'name' || next === 'human_reply_rate') setPerfSort(next)
                }}
                className="h-8 rounded border border-line bg-surface px-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
              >
                <option value="name">Name</option>
                <option value="human_reply_rate">Reply rate</option>
              </select>
              {/* The visible text IS the accessible name; an aria-label naming the
                  action would contradict the screen (WCAG 2.5.3). */}
              <button
                type="button"
                onClick={() => setPerfDirection(d => d === 'asc' ? 'desc' : 'asc')}
                className="h-8 rounded border border-line px-2.5 text-ink hover:bg-line-soft focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
                title={COPY.campaigns.sortDirectionAction(perfDirection)}
              >
                {perfDirection === 'asc' ? COPY.campaigns.sortAscending : COPY.campaigns.sortDescending}
              </button>
            </div>
          )}
        </div>
        {perf.length === 0 ? (
          <p className="text-[13px] text-ink-faint">No angle metrics yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-4 py-2 font-medium">Angle</th>
                  <th className="px-4 py-2 font-medium">Campaign</th>
                  <th className="px-4 py-2 text-right font-medium">Sent</th>
                  <th className="px-4 py-2 text-right font-medium">Replies</th>
                  <th className="px-4 py-2 text-right font-medium">Human-reply rate</th>
                </tr>
              </thead>
              <tbody>
                {sortedPerf.map(p => (
                  <tr key={p.angle_id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 text-ink">{p.angle_name}</td>
                    <td className="px-4 py-2 text-ink-muted">{p.campaign_name ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.emails_sent ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.unique_replies ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">
                      {p.attributed ? formatRate(p.human_reply_rate, 2) : 'unattributed'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            All angles
          </h2>
          {angles.length > 0 && (
            <input
              type="text"
              placeholder="Search angles or campaigns..."
              value={angleQuery}
              onChange={e => setAngleQuery(e.target.value)}
              className="h-8 rounded border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-ink-muted min-w-64"
            />
          )}
        </div>
        <div className="space-y-2">
          {filteredAngles.map(a => (
            <div key={`prov-${a.id}`} className="space-y-2">
            <div
              className="flex items-start justify-between gap-4 rounded-card border border-line bg-surface px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">{a.name}</p>
                <p className="mt-1 text-[11px] text-ink-faint">
                  {a.campaigns?.name ?? 'No campaign'}
                  {a.variant_label ? ` · variant ${a.variant_label}` : ''}
                </p>
              </div>
              <button
                onClick={() => remove(a.id)}
                aria-label={`Delete angle: ${a.name}`}
                className="shrink-0 text-[12px] text-ink-faint underline-offset-4 hover:text-ink hover:underline"
              >
                Delete
              </button>
            </div>
            <details className="rounded-card border border-line bg-surface px-4 py-2">
              <summary className="cursor-pointer text-[12px] text-ink-muted">
                History & approvals
              </summary>
              <ArtifactProvenance
                ownerEmail={ownerEmail}
                revisionsUrl="/api/revisions"
                approvalsUrl="/api/approvals"
                commentsUrl="/api/comments"
                artifactType="angles"
                artifactId={a.id}
                rowName={a.name}
              />
            </details>
            </div>
          ))}
          {angles.length > 0 && filteredAngles.length === 0 && (
            <p className="text-[13px] text-ink-faint">No angles match your search.</p>
          )}
          {angles.length === 0 && (
            <p className="text-[13px] text-ink-faint">No angles yet. Add the first one above.</p>
          )}
        </div>
      </section>
    </div>
  )
}
