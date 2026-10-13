'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BUTTON_PRIMARY } from '@/components/app/PageShell'
import { fetchRole } from '@/components/auth/useRole'
import { failedWriteText, thrownWriteText } from '@/components/auth/viewOnly'

/** Add a comment as the owner. @tab, @hermes, @claude… notify that teammate. */
export function CommentForm({ companyId, handles }: { companyId: number; handles: string[] }) {
  const router = useRouter()
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`/api/leads/${companyId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      })
      const json = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) setError(failedWriteText(res.status, json?.error, `Couldn’t post (${res.status}).`, await fetchRole()))
      else {
        setBody('')
        router.refresh?.()
      }
    } catch (err) {
      setError(thrownWriteText(err, await fetchRole()))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} data-write className="mt-3">
      <label htmlFor="comment-body" className="sr-only">
        Comment
      </label>
      <textarea
        id="comment-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={3}
        placeholder={`Note or ask a teammate: ${handles.slice(0, 3).map((h) => `@${h}`).join(', ')}…`}
        className="w-full resize-y rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink placeholder:text-ink-faint"
      />
      <div className="mt-2 flex items-center gap-3">
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy || !body.trim()}>
          {busy ? 'Posting…' : 'Comment'}
        </button>
        {error ? <span role="alert" className="text-xs text-bad">{error}</span> : null}
      </div>
    </form>
  )
}
