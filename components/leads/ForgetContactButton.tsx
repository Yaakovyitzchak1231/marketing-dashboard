'use client'

import { useState } from 'react'
import { forgetContactAction } from '@/app/actions/retention'

/**
 * Lead page ··· menu -> 'Forget this person' (plan 1.12). Typed confirmation:
 * the contact's own email (or "forget" when it has none), so this can't fire by
 * a stray click. PII is removed server-side; this button just shows the result.
 */
export function ForgetContactButton({ contactId, email }: { contactId: number; email: string | null }) {
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'done' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const expected = email ? email.trim().toLowerCase() : 'forget'

  if (state === 'done') {
    return <span className="text-[11px] text-ink-faint">Forgotten</span>
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="text-[11px] text-ink-faint underline decoration-dotted hover:text-bad">
        Forget this person
      </button>
    )
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 rounded-[4px] border border-bad/30 bg-bad-soft px-2 py-1">
      <span className="text-[11px] text-ink">
        Type <strong>{expected}</strong> to permanently remove this contact&apos;s info:
      </span>
      <input
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={expected}
        className="w-40 rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-[11px]"
        autoFocus
      />
      <button
        type="button"
        disabled={state === 'saving' || typed.trim().toLowerCase() !== expected}
        onClick={async () => {
          setState('saving')
          setError(null)
          const r = await forgetContactAction({ contact_id: contactId, confirm: typed.trim() })
          if (!r.ok) {
            setState('error')
            setError(r.error)
            return
          }
          setState('done')
        }}
        className="rounded-[3px] bg-bad px-2 py-0.5 text-[11px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-50"
      >
        {state === 'saving' ? 'Removing…' : 'Forget'}
      </button>
      <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-ink-faint hover:text-ink">
        Cancel
      </button>
      {error ? <span role="alert" className="w-full text-[11px] text-bad">{error}</span> : null}
    </span>
  )
}
