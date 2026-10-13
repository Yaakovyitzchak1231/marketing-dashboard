'use client'

import { useState } from 'react'
import { confirmRetentionSweepAction, previewRetentionSweepAction } from '@/app/actions/retention-sweep'
import type { RetentionPreview } from '@/lib/retention/store'

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const names = (xs: string[]) => (xs.length ? xs.join(', ') : 'none')

/**
 * Two steps, every time: review what the sweep will delete, then confirm. Old timeline
 * history is kept unless the owner ticks the box for this run; ticking it shows which score
 * models, traits and segments read those events (Instinct #86 finding 4) before confirming.
 */
export function RunSweepButton() {
  const [state, setState] = useState<'idle' | 'loading' | 'review' | 'running' | 'error'>('idle')
  const [preview, setPreview] = useState<RetentionPreview | null>(null)
  const [includeTimeline, setIncludeTimeline] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const btn = 'rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs font-medium text-ink-muted hover:text-ink disabled:cursor-not-allowed disabled:opacity-50'

  if ((state === 'review' || state === 'running') && preview) {
    const nothing = preview.total_touches === 0 && (!includeTimeline || preview.total_timeline_events === 0)
    const impact = preview.timeline_impact
    return (
      <div className="mt-2 rounded-card border border-line bg-surface p-3 text-xs text-ink-muted" data-testid="sweep-review">
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
        {includeTimeline && impact ? (
          <div className="mt-2 rounded-card border border-line p-2" data-testid="sweep-timeline-impact">
            <p className="font-medium text-ink">
              Deleting {plural(preview.total_timeline_events, 'timeline entry', 'timeline entries')} ({impact.event_types.join(', ')}) changes what is computed from them:
            </p>
            <ul className="mt-1 space-y-0.5">
              <li>Score models: {names(impact.score_models.map((m) => m.name))}</li>
              <li>Traits: {names(impact.traits.map((t) => t.label))}</li>
              <li>Segments with event conditions: {names(impact.segments.map((s) => s.name))}</li>
            </ul>
            <p className="mt-1">{impact.note}</p>
          </div>
        ) : null}
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
              const queued = r.recompute_queued ?? []
              setResult(
                `Deleted ${plural(r.total_deleted, 'event row', 'event rows')}` +
                  (includeTimeline ? ` and ${plural(r.total_timeline_deleted, 'timeline entry', 'timeline entries')}` : '; timeline kept') +
                  (queued.length ? `. Recompute queued (${queued.join(', ')}); see Jobs.` : ''),
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
      {result ? <span className={`text-xs ${state === 'error' ? 'text-bad' : 'text-ink-faint'}`}>{result}</span> : null}
    </div>
  )
}
