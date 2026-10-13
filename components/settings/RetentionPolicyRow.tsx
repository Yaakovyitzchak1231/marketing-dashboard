'use client'

import { useState } from 'react'
import { setRetentionPolicyAction } from '@/app/actions/retention'

export function RetentionPolicyRow({ category, keepDays, description }: { category: string; keepDays: number | null; description: string | null }) {
  const [value, setValue] = useState(keepDays == null ? '' : String(keepDays))
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)

  async function save() {
    const trimmed = value.trim()
    const keep_days = trimmed === '' ? null : Number(trimmed)
    if (keep_days !== null && (!Number.isInteger(keep_days) || keep_days <= 0)) {
      setState('error')
      setError('Enter a whole number of days, or leave blank for forever')
      return
    }
    setState('saving')
    setError(null)
    const r = await setRetentionPolicyAction({ event_category: category, keep_days })
    if (!r.ok) {
      setState('error')
      setError(r.error)
      return
    }
    setState('saved')
    setTimeout(() => setState('idle'), 1500)
  }

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft py-2 text-sm last:border-b-0">
      <div className="min-w-0">
        <div className="font-medium text-ink">{category.replace(/_/g, ' ')}</div>
        {description ? <div className="text-xs text-ink-faint">{description}</div> : null}
      </div>
      <div className="flex items-center gap-1.5">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="forever"
          inputMode="numeric"
          className="w-20 rounded-[3px] border border-line bg-surface px-1.5 py-1 text-right text-xs"
        />
        <span className="text-xs text-ink-faint">days</span>
        <button type="button" onClick={save} disabled={state === 'saving'} className="rounded-[3px] border border-line bg-surface px-2 py-1 text-xs text-ink-muted hover:text-ink disabled:opacity-50">
          {state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved' : 'Save'}
        </button>
      </div>
      {error ? <p role="alert" className="w-full text-2xs text-bad">{error}</p> : null}
    </div>
  )
}
