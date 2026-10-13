'use client'

import { useActionState, useState, type ReactNode } from 'react'
import type { OnceResult } from '@/app/actions/connect'

/**
 * A form whose server action may hand back a secret that is shown exactly once
 * (an API key, a webhook signing secret, an ntfy topic), with a copy button.
 */
export function OnceForm({
  action,
  children,
  submitLabel,
  className = '',
  buttonClassName = '',
}: {
  action: (prev: OnceResult | null, f: FormData) => Promise<OnceResult>
  children: ReactNode
  submitLabel: string
  className?: string
  buttonClassName?: string
}) {
  const [state, formAction, pending] = useActionState(action, null)
  const [copied, setCopied] = useState(false)
  return (
    <div className={className}>
      <form action={formAction} className="space-y-2">
        {children}
        <button type="submit" disabled={pending} className={buttonClassName}>
          {pending ? 'Working…' : submitLabel}
        </button>
      </form>
      {state ? (
        <div className={`mt-2 rounded-md border p-2 text-xs leading-snug ${state.ok ? 'border-line bg-surface' : 'border-bad/40 text-bad'}`} role="status">
          {state.secret ? (
            <>
              <p className="font-medium text-ink">{state.secretLabel ?? 'Secret'} (shown once)</p>
              <div className="mt-1 flex items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-canvas px-1.5 py-1 font-mono text-xs text-ink">{state.secret}</code>
                <button
                  type="button"
                  className="shrink-0 text-accent"
                  onClick={() => {
                    void navigator.clipboard?.writeText(state.secret ?? '')
                    setCopied(true)
                  }}
                >
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          ) : null}
          {state.message ? <p className={state.secret ? 'mt-1 text-ink-muted' : ''}>{state.message}</p> : null}
        </div>
      ) : null}
    </div>
  )
}
