'use client'

import { useState } from 'react'
import { confirmRetentionSweepAction, previewRetentionSweepAction } from '@/app/actions/retention-sweep'
import type { RetentionPreview } from '@/lib/retention/store'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`

/**
 * Two steps, every time: review what the sweep will delete, then confirm. Old timeline
 * history is kept unless the owner ticks the box for this run.
 */
export function RunSweepButton() {
  const [state, setState] = useState<'idle' | 'loading' | 'review' | 'running' | 'error'>('idle')
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [includeTimeline, setIncludeTimeline] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const btn = 'rounded-card border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'

  if ((state === 'review' || state === 'running') && preview) {
    const nothing = preview.total_touches === 0 && (!includeTimeline || preview.total_timeline_events === 0)
    return (
      <div className="mt-2 rounded-card border border-line bg-surface p-3 text-[12px] text-ink-muted" data-testid="sweep-review">
        <p className="font-medium text-ink">This sweep will delete:</p>
        {preview.categories.length === 0 ? (
          <p className="mt-1">Nothing. No event type has a retention window set.</p>
        ) : (
          <ul className="mt-1 space-y-0.5">
            {preview.categories.map((c) => (
              <li key={c.event_category}>
                {c.event_category} older than {plural(c.keep_days, 'day', 'days')}: {plural(c.touches, 'event', 'events')}
                {includeTimeline ? `, plus ${plural(c.timeline_events, 'timeline entry', 'timeline entries')}` : ''}
              </li>
            ))}
          </ul>
        )}
        <label className="mt-2 flex items-center gap-2">
          <input type="checkbox" checked={includeTimeline} onChange={(e) => setIncludeTimeline(e.target.checked)} disabled={state === 'running'} />
          Also delete old timeline history ({plural(preview.total_timeline_events, 'entry', 'entries')}). Scores already earned are kept.
        </label>
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className={btn}
            disabled={state === 'running' || nothing}
            onClick={async () => {
              setState('running')
              const r = await confirmRetentionSweepAction({ includeTimeline })
              if (!r.ok) {
                setState('error')
                setResult(r.error)
                return
              }
              setState('idle')
              setPreview(null)
              setResult(
                `Deleted ${plural(r.total_deleted, 'event row', 'event rows')}` +
                  (includeTimeline ? ` and ${plural(r.total_timeline_deleted, 'timeline entry', 'timeline entries')}` : '; timeline kept'),
              )
            }}
          >
            {state === 'running' ? 'Deleting…' : 'Confirm and delete'}
          </button>
          <button type="button" className={btn} disabled={state === 'running'} onClick={() => { setState('idle'); setPreview(null) }}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-2 flex items-center gap-2">
      <button
        type="button"
        disabled={state === 'loading'}
        onClick={async () => {
          setState('loading')
          setResult(null)
          setIncludeTimeline(false)
          const r = await previewRetentionSweepAction()
          if (!r.ok) {
            setState('error')
            setResult(r.error)
            return
          }
          setPreview(r)
          setState('review')
        }}
        className={btn}
      >
        {state === 'loading' ? 'Checking…' : 'Review sweep'}
      </button>
      {result ? <span className={`text-[12px] ${state === 'error' ? 'text-bad' : 'text-ink-faint'}`}>{result}</span> : null}
    </div>
  )
}
