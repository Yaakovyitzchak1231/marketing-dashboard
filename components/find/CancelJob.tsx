'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

export function CancelJob({ id }: { id: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          if (!confirm('Stop this job? What it already found stays in Leads.')) return
          setBusy(true)
          const r = await fetch(`/api/find/jobs/${id}/cancel`, { method: 'POST' })
          if (!r.ok) setErr((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`)
          setBusy(false)
          router.refresh()
        }}
        className="text-xs text-bad hover:underline disabled:opacity-50"
      >
        {busy ? 'Stopping…' : 'Cancel'}
      </button>
      {err ? <span className="text-xs text-bad">{err}</span> : null}
    </span>
  )
}
