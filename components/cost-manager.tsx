'use client'

import { useState } from 'react'
import { useApi } from '@/components/use-api'
import { SUM_START, MIN_AMOUNT_USD, CURRENCY_PRECISION } from '@/lib/format'
import { COPY } from '@/lib/copy'
import { exportToCsv } from '@/lib/csv'

type Cost = {
  id: string
  amount_usd: number
  category: string
  entity_ref: string | null
  spent_at: string | null
  notes: string | null
}

type Idea = { id: string; name: string }

// These must match the costs.category CHECK constraint in
// supabase/migrations/002_unified_model.sql exactly. An invented category
// (a plural label, or an "other" bucket) is rejected by Postgres, so the form
// offers only what the schema accepts.
const CATEGORIES = ['domain', 'inbox', 'verification', 'tool', 'list'] as const

export function CostManager({ initialCosts, ideas }: { initialCosts: Cost[]; ideas: Idea[] }) {
  const api = useApi()
  const [costs, setCosts] = useState<Cost[]>(initialCosts)
  const [amount, setAmount] = useState('')
  const [category, setCategory] = useState<string>(CATEGORIES[0])
  const [ideaId, setIdeaId] = useState('')
  const [notes, setNotes] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // entity_ref holds an idea id when a cost was linked to one. Resolve it
  // against the ideas we were handed; an id with no matching idea renders as
  // unknown rather than inventing a label.
  const ideaNameFor = (ref: string | null): string | null => {
    if (!ref) return null
    return ideas.find(i => i.id === ref)?.name ?? null
  }

  const refresh = async () => setCosts(await api('/api/costs'))

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    const value = Number(amount)
    if (!Number.isFinite(value) || value < MIN_AMOUNT_USD) {
      setError('Enter a non-negative amount.')
      return
    }
    setSaving(true)
    setError(null)
    try {
      await api('/api/costs', {
        method: 'POST',
        body: JSON.stringify({
          amount_usd: value,
          category,
          // costs has no idea_id column; entity_ref is the schema's free-text
          // pointer, so the idea id is recorded there rather than in a
          // column that does not exist.
          entity_ref: ideaId || null,
          notes: notes.trim() || null,
        }),
      })
      setAmount('')
      setNotes('')
      setIdeaId('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record cost')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (id: string) => {
    if (!confirm('Delete this cost record?')) return
    try {
      await api(`/api/costs/${id}`, { method: 'DELETE' })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete cost')
    }
  }

  const handleExportCosts = () => {
    const headers = ['Date', 'Category', 'Idea', 'Amount USD', 'Notes']
    // `c.category` is the stored value and is written as-is: it is either one of
    // CATEGORIES or whatever the API last accepted, and relabelling it here
    // would put a word in the file that the row does not carry.
    const data = costs.map(c => {
      const linkedIdea = c.entity_ref ? ideas.find(i => i.id === c.entity_ref) : null
      return [
        c.spent_at ? c.spent_at.split('T')[0] : null,
        c.category,
        linkedIdea ? linkedIdea.name : c.entity_ref,
        c.amount_usd,
        c.notes,
      ]
    })
    exportToCsv('costs', headers, data)
  }

  const total = costs.reduce((t, c) => t + Number(c.amount_usd), SUM_START)

  return (
    <div className="space-y-8">
      {error && (
        <div role="alert" className="border-l-2 border-warn px-3 py-2 text-xs text-ink-muted">{error}</div>
      )}

      <section className="rounded-card border border-line bg-surface px-5 py-4">
        <h2 className="text-xs font-medium text-ink">Record spend</h2>
        <form onSubmit={create} className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-5 sm:items-end">
          <label>
            <span className="mb-1 block text-2xs text-ink-muted">Amount (USD)</span>
            <input
              value={amount}
              onChange={e => setAmount(e.target.value)}
              inputMode="decimal"
              placeholder={COPY.costManager.amountPlaceholder}
              className="w-full rounded border border-line bg-white px-3 py-2 text-sm tabular-nums text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <label>
            <span className="mb-1 block text-2xs text-ink-muted">Category</span>
            <select
              value={category}
              onChange={e => setCategory(e.target.value)}
              className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 sm:col-span-1">
            <span className="mb-1 block text-2xs text-ink-muted">Idea</span>
            <select
              value={ideaId}
              onChange={e => setIdeaId(e.target.value)}
              className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            >
              <option value="">Unlinked</option>
              {ideas.map(i => (
                <option key={i.id} value={i.id}>{i.name}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 sm:col-span-1">
            <span className="mb-1 block text-2xs text-ink-muted">Notes</span>
            <input
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="What was this for?"
              className="w-full rounded border border-line bg-white px-3 py-2 text-sm text-ink outline-none focus:border-ink-muted focus-visible:ring-2 focus-visible:ring-ink-muted"
            />
          </label>
          <button
            type="submit"
            disabled={saving}
            className="col-span-2 rounded bg-ink px-4 py-2 text-sm text-white disabled:opacity-40 sm:col-span-1"
          >
            {saving ? 'Saving…' : 'Record'}
          </button>
        </form>
      </section>

      <section>
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-muted">
            History
          </h2>
          <div className="flex items-center gap-4 text-sm text-ink">
            {costs.length > 0 && (
              <button
                type="button"
                onClick={handleExportCosts}
                className="text-2xs text-ink-muted hover:text-ink underline underline-offset-2"
              >
                Export visible CSV
              </button>
            )}
            <p className="tabular-nums">
              Total <span className="font-medium">${total.toLocaleString(undefined, { maximumFractionDigits: CURRENCY_PRECISION })}</span>
            </p>
          </div>
        </div>
        {costs.length === 0 ? (
          <p className="text-sm text-ink-faint">No costs recorded yet.</p>
        ) : (
          <div className="overflow-x-auto rounded-card border border-line bg-surface">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-2xs uppercase tracking-[0.06em] text-ink-muted">
                  <th className="px-4 py-2 font-medium">Date</th>
                  <th className="px-4 py-2 font-medium">Category</th>
                  <th className="px-4 py-2 font-medium">Idea</th>
                  <th className="px-4 py-2 font-medium">Notes</th>
                  <th className="px-4 py-2 text-right font-medium">Amount</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {costs.map(c => (
                  <tr key={c.id} className="border-b border-line last:border-0">
                    <td className="px-4 py-2 tabular-nums text-ink-muted">{c.spent_at ?? '—'}</td>
                    <td className="px-4 py-2 text-ink-muted">{c.category}</td>
                    {/* costs has no ideas FK, so the linked idea is the
                        free-text entity_ref we stored, not a joined row. */}
                    <td className="px-4 py-2 text-ink">
                      {ideaNameFor(c.entity_ref) ?? '—'}
                    </td>
                    <td className="px-4 py-2 text-ink-faint">{c.notes ?? '—'}</td>
                    <td className="px-4 py-2 text-right tabular-nums text-ink">
                      ${Number(c.amount_usd).toLocaleString(undefined, { maximumFractionDigits: CURRENCY_PRECISION })}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => remove(c.id)}
                        aria-label={`Delete cost of $${Number(c.amount_usd).toLocaleString(undefined, { maximumFractionDigits: CURRENCY_PRECISION })} for ${c.category}`}
                        className="text-xs text-ink-faint underline-offset-4 hover:text-ink hover:underline"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  )
}
