'use client'

import { useRef, useState } from 'react'
import { updateEntityAction } from '@/app/actions/edit'
import { fetchRole, useRole } from '@/components/auth/useRole'
import { VIEW_ONLY_PROPS, VIEW_ONLY_TOAST, announceViewOnly, isViewerRefusal, thrownWriteText } from '@/components/auth/viewOnly'

export interface InlineEditOption {
  value: string
  label: string
}

/**
 * One field, inline: click (or tab to) the value, it becomes an input or
 * select, Enter or blur saves, Esc cancels. Optimistic — the new value shows
 * right away and rolls back if the save fails. Used in the leads table, the
 * lead detail page and the campaign page (plan item 1.3).
 *
 * Viewers never enter edit mode: the value is marked view-only (aria-disabled,
 * like the form buttons ViewOnlyGuard marks) and a click shows the calm
 * view-only note. If a refused save still slips through (role not loaded yet),
 * the 403 reads as view-only, not as a network failure.
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
  const viewer = useRole() === 'viewer'

  function open() {
    if (viewer) {
      announceViewOnly()
      return
    }
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
        setError(isViewerRefusal(r.error, null) ? VIEW_ONLY_TOAST : r.error)
        return
      }
      setState('idle')
      onSaved?.(r.to)
    } catch (err) {
      setShown(prev)
      setState('error')
      setError(thrownWriteText(err, await fetchRole(), 'Not saved.'))
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        onClick={open}
        disabled={state === 'saving'}
        aria-label={viewer ? `${label} (view-only)` : `Edit ${label}`}
        {...(viewer ? VIEW_ONLY_PROPS : {})}
        className={`group inline-flex min-h-[1.25rem] items-center gap-1 rounded-[3px] px-1 py-0.5 text-left ${viewer ? 'cursor-not-allowed' : 'hover:bg-canvas/70'} ${state === 'saving' ? 'opacity-60' : ''} ${className}`}
      >
        <span className={shown ? '' : 'text-unavailable'}>{shown ?? placeholder}</span>
        {state === 'saving' ? <span className="text-2xs text-ink-faint">saving…</span> : null}
        {state === 'error' ? (
          <span role="alert" className="text-2xs text-bad">
            {error ?? 'not saved'}
          </span>
        ) : null}
      </button>
    )
  }

  const inputClass = 'rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-sm text-ink'
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
