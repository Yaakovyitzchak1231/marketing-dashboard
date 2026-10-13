'use client'

import { useState } from 'react'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'

/**
 * Pause / Resume for one agent (or for all agents). The first click only opens
 * the confirm line with an optional reason; the second click submits.
 */
export function PauseControl({
  paused,
  pauseAction,
  resumeAction,
  fields = {},
  pauseLabel,
  resumeLabel,
  pauseText,
  resumeText,
}: {
  paused: boolean
  pauseAction: (f: FormData) => void | Promise<void>
  resumeAction: (f: FormData) => void | Promise<void>
  fields?: Record<string, string>
  pauseLabel: string
  resumeLabel: string
  pauseText: string
  resumeText: string
}) {
  const [open, setOpen] = useState(false)
  const label = paused ? resumeLabel : pauseLabel
  if (!open) {
    return (
      <button type="button" className={BUTTON} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }
  return (
    <form
      action={paused ? resumeAction : pauseAction}
      className="flex flex-wrap items-center gap-2 rounded-control border border-warn/30 bg-warn-soft px-2.5 py-1.5"
      role="group"
      aria-label={`Confirm: ${label}`}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="confirm" value="yes" />
      <span className="w-full text-xs text-warn">{paused ? resumeText : pauseText}</span>
      {paused ? null : (
        <input
          name="reason"
          maxLength={500}
          aria-label="Reason"
          placeholder="Reason (optional, shown to the agent)"
          className="min-w-0 flex-1 rounded-control border border-line bg-surface px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ink-muted"
        />
      )}
      <button type="submit" className={BUTTON_PRIMARY}>
        {label}
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  )
}
