'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

/**
 * "Owner research exhausted" on the lead page. Marking it lets this store's role
 * inbox (role-based-hold) go out as Ready-generic in role-inbox batches; undoing
 * it puts the inbox back on hold. Confirm first; logged with who did it.
 */
export function OwnerResearchToggle({ companyId, exhausted, at, by }: { companyId: number; exhausted: boolean; at: string | null; by: string | null }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  async function send() {
    setBusy(true)
    setErr(null)
    try {
      const r = await fetch(`/api/leads/${companyId}/owner-research`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ exhausted: !exhausted, note: note || null }),
      })
      const j = (await r.json().catch(() => ({}))) as { error?: string }
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`)
      setOpen(false)
      router.refresh()
    } catch (e) {
      setErr((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const btn = 'rounded-control border border-line bg-surface px-2.5 py-1 text-xs text-ink hover:border-ink-faint disabled:opacity-50'
  return (
    <div className="text-xs text-ink-muted">
      {exhausted ? (
        <p>
          Owner research exhausted{at ? ` on ${at}` : ''}{by ? ` by ${by}` : ''}: the role inbox can go out in role-inbox batches (no-name copy).
        </p>
      ) : (
        <p>Owner research not marked done: a role inbox here stays on hold.</p>
      )}
      {open ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="note (optional)" aria-label="Note" className="rounded-control border border-line bg-surface px-2 py-1 text-xs" />
          <button type="button" className={btn} disabled={busy} onClick={send}>
            {exhausted ? 'Yes, reopen research' : 'Yes, mark exhausted'}
          </button>
          <button type="button" className={btn} onClick={() => setOpen(false)}>
            Cancel
          </button>
        </div>
      ) : (
        <button type="button" className={`${btn} mt-2`} onClick={() => setOpen(true)}>
          {exhausted ? 'Reopen owner research' : 'Mark owner research exhausted'}
        </button>
      )}
      {err ? <p role="alert" className="mt-1 text-bad">{err}</p> : null}
    </div>
  )
}
