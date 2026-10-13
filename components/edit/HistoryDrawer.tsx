'use client'

import { useState } from 'react'
import { entityHistoryAction } from '@/app/actions/edit'
import type { HistoryRow } from '@/lib/edit/history'

const VIA_LABEL: Record<string, string> = { ui: 'dashboard', ops_api: 'API', webhook: 'webhook', runner: 'runner', import: 'import', trigger: 'automatic' }

function relative(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime()
  const min = Math.round(ms / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.round(hr / 24)
  return `${d}d ago`
}

function line(r: HistoryRow): string {
  const who = r.changed_by_name
  const via = r.via ? ` · via ${VIA_LABEL[r.via] ?? r.via}` : ''
  const from = r.old_value ?? '(empty)'
  const to = r.new_value ?? '(empty)'
  return `${who} changed ${r.field} from ${from} to ${to} · ${relative(r.changed_at)}${via}`
}

/**
 * A slide-over panel listing one entity's changes, newest first — "Tab changed
 * stage from new to ready · 2h ago · via API". Opened from the lead detail and
 * campaign pages (plan item 1.3).
 */
export function HistoryDrawer({ type, id, label = 'History' }: { type: string; id: string | number; label?: string }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<HistoryRow[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function show() {
    setOpen(true)
    if (rows !== null) return
    setLoading(true)
    setError(null)
    try {
      const r = await entityHistoryAction({ type, id, limit: 100 })
      if (!r.ok) setError(r.error)
      else setRows(r.rows)
    } catch {
      setError('Couldn’t load history.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <button type="button" onClick={show} className="text-xs text-accent hover:underline">
        {label}
      </button>
      {open ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-ink/20" role="dialog" aria-label="History" onClick={() => setOpen(false)}>
          <div className="h-full w-full max-w-sm overflow-y-auto border-l border-line bg-surface p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-ink">History</h2>
              <button type="button" onClick={() => setOpen(false)} className="text-xs text-ink-faint hover:text-ink" aria-label="Close history">
                Close
              </button>
            </div>
            {loading ? <p className="text-xs text-ink-faint">Loading…</p> : null}
            {error ? (
              <p role="alert" className="text-xs text-bad">
                {error}
              </p>
            ) : null}
            {!loading && !error && rows && rows.length === 0 ? <p className="text-xs text-ink-faint">No changes yet.</p> : null}
            {rows && rows.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {rows.map((r) => (
                  <li key={r.id} className="border-b border-line-soft pb-2 text-xs text-ink-muted last:border-0">
                    {line(r)}
                    {r.note ? <div className="mt-0.5 text-2xs text-ink-faint">{r.note}</div> : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      ) : null}
    </>
  )
}
