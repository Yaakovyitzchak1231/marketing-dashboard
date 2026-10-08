'use client'

import { useEffect } from 'react'

/** Route error boundary. Says plainly that it failed; never shows stale or fake numbers. */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error)
  }, [error])
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
