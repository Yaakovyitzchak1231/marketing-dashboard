'use client'

import { useRef, useState } from 'react'
import { updateEntityAction } from '@/app/actions/edit'

export interface InlineEditOption {
  value: string
  label: string
}

/**
 * One field, inline: click (or tab to) the value, it becomes an input or
 * select, Enter or blur saves, Esc cancels. Optimistic — the new value shows
 * right away and rolls back if the save fails. Used in the leads table, the
 * lead detail page and the campaign page (plan item 1.3).
 */
export function InlineEditCell({
  type,
  id,
  field,
  value,
  label,
  options,
  placeholder = '—',
  className = '',
  onSaved,
}: {
  /** The entity type (company, contact, campaign, campaign_lead, task). */
  type: string
  /** The entity's id; for campaign_lead, "<campaign_id>:<company_id>". */
  id: string | number
  field: string
  value: string | null
  label: string
  /** Present -> renders a <select>; absent -> a text input. */
  options?: readonly InlineEditOption[]
  placeholder?: string
  className?: string
  onSaved?: (next: string | null) => void
}) {
  const [editing, setEditing] = useState(false)
  const [shown, setShown] = useState(value)
  const [draft, setDraft] = useState(value ?? '')
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const prevRef = useRef(value)

  function open() {
    prevRef.current = shown
    setDraft(shown ?? '')
    setError(null)
    setEditing(true)
  }
  function cancel() {
    setEditing(false)
    setDraft(shown ?? '')
    setError(null)
  }

  async function save(nextRaw: string) {
    const next = nextRaw.trim() === '' ? null : nextRaw
    if ((next ?? '') === (shown ?? '')) {
      setEditing(false)
      return
    }
    const prev = shown
    setShown(next) // optimistic
    setEditing(false)
    setState('saving')
    setError(null)
    try {
      const r = await updateEntityAction({ type, id, field, value: next })
      if (!r.ok) {
        setShown(prev)
        setState('error')
        setError(r.error)
        return
      }
      setState('idle')
      onSaved?.(r.to)
    } catch {
      setShown(prev)
      setState('error')
      setError('Couldn’t reach the server. Not saved.')
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        disabled={state === 'saving'}
        aria-label={`Edit ${label}`}
        className={`group inline-flex min-h-[1.25rem] items-center gap-1 rounded-[3px] px-1 py-0.5 text-left hover:bg-canvas/70 ${state === 'saving' ? 'opacity-60' : ''} ${className}`}
      >
        <span className={shown ? '' : 'text-unavailable'}>{shown ?? placeholder}</span>
        {state === 'saving' ? <span className="text-[10px] text-ink-faint">saving…</span> : null}
        {state === 'error' ? (
          <span role="alert" className="text-[10px] text-bad">
            {error ?? 'not saved'}
          </span>
        ) : null}
      </button>
    )
  }

  const inputClass = 'rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-[13px] text-ink'
  if (options) {
    return (
      <select
        autoFocus
        aria-label={label}
        value={draft}
        disabled={state === 'saving'}
        onChange={(e) => void save(e.target.value)}
        onBlur={(e) => void save(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') cancel()
        }}
        className={`${inputClass} ${className}`}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }
  return (
    <input
      autoFocus
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => void save(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void save(draft)
        } else if (e.key === 'Escape') {
          cancel()
        }
      }}
      className={`${inputClass} ${className}`}
    />
  )
}
