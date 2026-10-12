'use client'

import { useState } from 'react'
import { askToChangeAction } from '@/app/actions/edit'
import { fetchRole, useRole } from '@/components/auth/useRole'
import { VIEW_ONLY_PROPS, VIEW_ONLY_TOAST, announceViewOnly, isViewerRefusal, thrownWriteText } from '@/components/auth/viewOnly'

/**
 * For a number that comes from Instantly (emails sent, opens, replies): it is
 * never edited in place. "Ask to change" files a request with the proposed
 * value and a reason into "Needs your OK" on Activity (lib/edit/ask-change.ts).
 * Viewers get the calm view-only note instead of the form.
 */
export function AskToChange({
  companyId,
  campaignId,
  field,
  label,
}: {
  companyId: number
  campaignId: number
  field: 'steps' | 'opens' | 'replies'
  label: string
}) {
  const viewer = useRole() === 'viewer'
  const [open, setOpen] = useState(false)
  const [proposed, setProposed] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)

  function start() {
    if (viewer) {
      announceViewOnly()
      return
    }
    setNote(null)
    setOpen(true)
  }

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (viewer) return announceViewOnly()
    setBusy(true)
    setNote(null)
    try {
      const r = await askToChangeAction({ companyId, campaignId, field, proposed, reason })
      if (!r.ok) setNote({ tone: 'bad', text: isViewerRefusal(r.error, null) ? VIEW_ONLY_TOAST : r.error })
      else {
        setNote({ tone: 'good', text: `Asked. It is waiting in Needs your OK on Activity; ${label} still reads ${r.current} until Instantly says otherwise.` })
        setOpen(false)
        setProposed('')
        setReason('')
      }
    } catch (err) {
      setNote({ tone: 'bad', text: thrownWriteText(err, await fetchRole(), 'Not sent.') })
    } finally {
      setBusy(false)
    }
  }

  const input = 'w-full rounded-[3px] border border-line bg-surface px-1.5 py-0.5 text-[12px] text-ink'
  return (
    <div className="mt-1 text-left">
      {open ? (
        <form onSubmit={send} className="space-y-1" aria-label={`Ask to change ${label}`}>
          <label className="block text-[11px] text-ink-faint">
            Should read
            <input className={`${input} tabular-nums`} inputMode="numeric" value={proposed} onChange={(e) => setProposed(e.target.value)} />
          </label>
          <label className="block text-[11px] text-ink-faint">
            Why
            <input className={input} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="flex gap-2 text-[11.5px]">
            <button type="submit" className="text-accent hover:underline disabled:opacity-50" disabled={busy || !proposed.trim() || !reason.trim()}>
              {busy ? 'Sending…' : 'Send for OK'}
            </button>
            <button type="button" className="text-ink-faint hover:text-ink" onClick={() => setOpen(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <button
          type="button"
          onClick={start}
          aria-label={viewer ? `Ask to change ${label} (view-only)` : `Ask to change ${label}`}
          {...(viewer ? VIEW_ONLY_PROPS : {})}
          className={`text-[11px] ${viewer ? 'cursor-not-allowed text-ink-faint opacity-50' : 'text-ink-faint hover:text-ink'}`}
        >
          Ask to change
        </button>
      )}
      {note ? (
        <p role="status" className={`mt-1 text-[11px] ${note.tone === 'good' ? 'text-good' : 'text-bad'}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  )
}
