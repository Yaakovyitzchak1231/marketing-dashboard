'use client'

import { useState } from 'react'
import { useApi } from '@/components/use-api'
import { PERFORMANCE_RANGE_LABEL } from '@/lib/range'
import { CURRENCY_PRECISION } from '@/lib/format'
import { exportToCsv } from '@/lib/csv'
import { compareByMetric, compareByName } from '@/lib/sort'
import { COPY } from '@/lib/copy'
import { ArtifactProvenance } from '@/components/artifact-provenance'

type Idea = {
  id: string
  name: string
  description: string | null
  status: string
  channels?: { name: string } | null
}

type PerfRow = {
  idea_id: string
  idea_name: string
  status: string
  spend_usd: number | null
  replies: number | null
  meetings: number | null
  customers: number | null
  meetings_per_100_usd: number | null
  cost_per_reply_usd: number | null
  cost_per_meeting_usd: number | null
  cost_per_customer_usd: number | null
}

/**
 * Display precision for the locale format below. Not a metric -- it only
 * decides how many digits of a stored number are shown. Lives in lib/format.ts
 * so the render path carries no bare literal.
 */
const fmt = (v: number | null, digits = CURRENCY_PRECISION) =>
  v === null || v === undefined ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: digits })

export function IdeaManager({
  initialIdeas,
  initialPerformance,
  ownerEmail,
}: {
  initialIdeas: Idea[]
  initialPerformance: PerfRow[]
  ownerEmail?: string
}) {
  const api = useApi()
  const [ideas, setIdeas] = useState<Idea[]>(initialIdeas)
  const [perf] = useState<PerfRow[]>(initialPerformance)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [perfSort, setPerfSort] = useState<'name' | 'spend' | 'cost_per_reply' | 'cost_per_meeting'>('name')
  const [perfDirection, setPerfDirection] = useState<'asc' | 'desc'>('asc')
  const [ideaQuery, setIdeaQuery] = useState('')

  // A cost the collector never computed is absent, so it sinks in both
  // directions rather than floating to the top of a descending sort. The key is
  // mapped to the column it really names so the comparator reads a typed field.
  const PERF_SORT_KEYS = {
    spend: 'spend_usd',
    cost_per_reply: 'cost_per_reply_usd',
    cost_per_meeting: 'cost_per_meeting_usd',
  } as const

  const perfLabel = (row: PerfRow) => row.idea_name
  const sortedPerf = [...perf].sort((a, b) =>
    perfSort === 'name'
      ? compareByName(a, b, perfDirection, perfLabel)
      : compareByMetric(a, b, PERF_SORT_KEYS[perfSort], perfDirection, perfLabel),
  )

  const filteredIdeas = ideas.filter(i =>
    !ideaQuery || i.name.toLowerCase().includes(ideaQuery.toLowerCase())
  )

  const refresh = async () => {
    const data = await api('/api/ideas')
    setIdeas(data)
  }

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    setError(null)
    try {
      await api('/api/ideas', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      })
      setName('')
      setDescription('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create idea')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this idea? Costs linked to it will keep their records but lose the link.')) return
    try {
      await api(`/api/ideas/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete idea')
    }
  }

  const handleExportPerformance = () => {
    const headers = ['Idea', 'Spend USD', 'Meetings per 100 USD', 'Cost per Reply USD', 'Cost per Meeting USD', 'Cost per Customer USD']
    const data = sortedPerf.map(p => [
      p.idea_name,
      p.spend_usd,
      p.meetings_per_100_usd,
      p.cost_per_reply_usd,
      p.cost_per_meeting_usd,
      p.cost_per_customer_usd
    ])
    exportToCsv('ideas_performance', headers, data)
  }

  return (
    <div className="space-y-8">
      {error && (
        <div role="alert" className="border-l-2 border-warn px-3 py-2 text-[12px] text-ink-muted">{error}</div>
      )}

      <section className="rounded-card border border-line bg-surface px-5 py-4">
        <h2 className="text-[12px] font-medium text-ink">New idea</h2>
        <form onSubmit={create} className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1">
            <span className="mb-1 block text-[11px] text-ink-muted">Name</span>
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Jewelry retailers outreach"
              className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <label className="flex-[2]">
            <span className="mb-1 block text-[11px] text-ink-muted">Description</span>
            <input
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What is the offer, who is it for?"
              className="w-full rounded border border-line bg-white px-3 py-2 text-[13px] text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <button
            type="submit"
            disabled={saving || !name.trim()}
            className="rounded bg-ink px-4 py-2 text-[13px] text-white disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Add idea'}
          </button>
        </form>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            Performance — {PERFORMANCE_RANGE_LABEL}
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
                  if (next in PERF_SORT_KEYS || next === 'name') {
                    setPerfSort(next as typeof perfSort)
                  }
                }}
                className="h-8 rounded border border-line bg-surface px-2 text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
              >
                <option value="name">Name</option>
                <option value="spend">Spend</option>
                <option value="cost_per_reply">Cost / reply</option>
                <option value="cost_per_meeting">Cost / meeting</option>
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
          <p className="text-[13px] text-ink-faint">
            No spend or outcomes recorded yet. Add costs on the Costs page and link campaigns to ideas.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-4 py-2 font-medium">Idea</th>
                  <th className="px-4 py-2 text-right font-medium">Spend</th>
                  <th className="px-4 py-2 text-right font-medium">Meetings / $100</th>
                  <th className="px-4 py-2 text-right font-medium">Cost / reply</th>
                  <th className="px-4 py-2 text-right font-medium">Cost / meeting</th>
                  <th className="px-4 py-2 text-right font-medium">Cost / customer</th>
                </tr>
              </thead>
              <tbody>
                {sortedPerf.map(p => (
                  <tr key={p.idea_id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 text-ink">{p.idea_name}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.spend_usd !== null ? `$${fmt(p.spend_usd)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">
                      {fmt(p.meetings_per_100_usd)}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.cost_per_reply_usd !== null ? `$${fmt(p.cost_per_reply_usd)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.cost_per_meeting_usd !== null ? `$${fmt(p.cost_per_meeting_usd)}` : '—'}
                    </td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink-muted">
                      {p.cost_per_customer_usd !== null ? `$${fmt(p.cost_per_customer_usd)}` : '—'}
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
            All ideas
          </h2>
          {ideas.length > 0 && (
            <input
              type="text"
              placeholder="Search ideas..."
              value={ideaQuery}
              onChange={e => setIdeaQuery(e.target.value)}
              className="h-8 rounded border border-line bg-surface px-2 text-[12px] text-ink outline-none focus:border-ink-muted"
            />
          )}
        </div>
        <div className="space-y-2">
          {filteredIdeas.map(idea => (
            <div key={`prov-${idea.id}`} className="space-y-2">
            <div
              className="flex items-start justify-between gap-4 rounded-card border border-line bg-surface px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-ink">{idea.name}</p>
                {idea.description && (
                  <p className="mt-0.5 text-[12px] text-ink-faint">{idea.description}</p>
                )}
                <p className="mt-1 text-[11px] text-ink-faint">
                  {idea.channels?.name ?? 'No channel'} · {idea.status}
                </p>
              </div>
              <button
                onClick={() => remove(idea.id)}
                aria-label={`Delete idea: ${idea.name}`}
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
                artifactType="ideas"
                artifactId={idea.id}
                rowName={idea.name}
              />
            </details>
            </div>
          ))}
          {ideas.length > 0 && filteredIdeas.length === 0 && (
            <p className="text-[13px] text-ink-faint">No ideas match your search.</p>
          )}
          {ideas.length === 0 && (
            <p className="text-[13px] text-ink-faint">No ideas yet. Add the first one above.</p>
          )}
        </div>
      </section>
    </div>
  )
}
