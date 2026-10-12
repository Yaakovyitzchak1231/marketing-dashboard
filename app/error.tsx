'use client'

import { useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useRole } from '@/components/auth/useRole'
import { NEXT_UNEXPECTED_ACTION_RESPONSE, isViewerRefusal } from '@/components/auth/viewOnly'

/** Route error boundary. Says plainly that it failed; never shows stale or fake numbers. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const role = useRole()
  const router = useRouter()
  const viewOnly = isViewerRefusal(error, role)

  // Until the role is known, a bare "unexpected response" could be either; wait
  // (the guard has usually fetched the role already) rather than flash the scary card.
  const pending = role === undefined && error.message === NEXT_UNEXPECTED_ACTION_RESPONSE

  useEffect(() => {
    if (role !== undefined && !viewOnly) console.error(error)
  }, [error, role, viewOnly])

  if (pending) return <div className="min-h-screen" aria-busy="true" />

  if (viewOnly) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-[460px] rounded-card border border-line bg-surface px-6 py-7 shadow-card">
          <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-ink-muted">View-only access</p>
          <h1 className="mt-1.5 text-[18px] font-semibold text-ink">You can look, not change</h1>
          <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
            Nothing was changed. To edit, ask an owner to make you an Editor in Settings.
          </p>
          <button
            type="button"
            onClick={() => {
              reset()
              router.refresh()
            }}
            className="mt-5 rounded-card bg-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-accent/90"
          >
            Back to the page
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[460px] rounded-card border border-line bg-surface px-6 py-7 shadow-card">
        <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-bad">Couldn&rsquo;t load</p>
        <h1 className="mt-1.5 text-[18px] font-semibold text-ink">The dashboard hit an error</h1>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-muted">
          No numbers are shown, so nothing on screen can be wrong. This is usually Instantly being slow or a temporary
          network problem. Try again in a moment.
        </p>
        {error.digest ? <p className="mt-3 font-numeric text-[11px] text-ink-faint">Reference: {error.digest}</p> : null}
        <button
          type="button"
          onClick={reset}
          className="mt-5 rounded-card bg-accent px-4 py-2 text-[13px] font-medium text-white hover:bg-accent/90"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
