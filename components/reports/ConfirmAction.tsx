'use client'

import { useState, type ReactNode } from 'react'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'

/**
 * A two-step button for anything that changes Instantly: the first click only
 * opens the confirm line (what will happen, in plain words); the second click
 * submits the form with confirm=yes. Nothing happens on the first click.
 */
export function ConfirmAction({
  action,
  fields,
  label,
  confirmText,
  confirmLabel = 'Yes, do it',
  tone = 'default',
  disabled,
  disabledReason,
}: {
  action: (f: FormData) => void | Promise<void>
  fields: Record<string, string>
  label: string
  confirmText: ReactNode
  confirmLabel?: string
  tone?: 'default' | 'primary'
  disabled?: boolean
  disabledReason?: string
}) {
  const [open, setOpen] = useState(false)
  if (disabled) {
    return (
      <span className={`${BUTTON} cursor-not-allowed opacity-50`} title={disabledReason}>
        {label}
      </span>
    )
  }
  if (!open) {
    return (
      <button type="button" className={tone === 'primary' ? BUTTON_PRIMARY : BUTTON} onClick={() => setOpen(true)}>
        {label}
      </button>
    )
  }
  return (
    <form action={action} className="flex flex-wrap items-center gap-2 rounded-control border border-warn/30 bg-warn-soft px-2.5 py-1.5" role="group" aria-label={`Confirm: ${label}`}>
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <input type="hidden" name="confirm" value="yes" />
      <span className="text-xs text-warn">{confirmText}</span>
      <button type="submit" className={BUTTON_PRIMARY}>
        {confirmLabel}
      </button>
      <button type="button" className={BUTTON} onClick={() => setOpen(false)}>
        Cancel
      </button>
    </form>
  )
}
