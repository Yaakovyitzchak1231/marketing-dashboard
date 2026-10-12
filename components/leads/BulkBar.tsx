'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { STAGES, type Stage } from '@/lib/leads/types'
import { STAGE_LABELS } from '@/lib/leads/filters'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { VerifyButton } from '@/components/verify/VerifyButton'
import Link from 'next/link'
import { fetchRole, useRole } from '@/components/auth/useRole'
import { BULK_FIELD_CHOICES } from '@/lib/edit/bulk-fields'
import { VIEW_ONLY_DIM, VIEW_ONLY_PROPS, announceViewOnly, failedWriteText, thrownWriteText } from '@/components/auth/viewOnly'

export interface Selected {
  companyIds: number[]
  /** Unverified contact ids across the selected companies. */
  unverifiedContactIds: number[]
}

/** Actions on the selected leads. Each result is said in plain words; nothing fails silently. */
export function BulkBar({ selected, onDone }: { selected: Selected; onDone: () => void }) {
  const router = useRouter()
  const [stage, setStage] = useState<Stage | ''>('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [lists, setLists] = useState<{ id: number; name: string }[]>([])
  const [listChoice, setListChoice] = useState('')
  const [newListName, setNewListName] = useState('')
  const [editField, setEditField] = useState('')
  const [editValue, setEditValue] = useState('')
  const [confirming, setConfirming] = useState(false)
  const viewer = useRole() === 'viewer'

  useEffect(() => {
    fetch('/api/leads/lists')
      .then((r) => r.json())
      .then((b: { lists?: { id: number; name: string }[] }) => setLists(b.lists ?? []))
      .catch(() => {})
  }, [])
  const n = selected.companyIds.length
  if (n === 0) {
    // The selection clears after an action; its result stays readable.
    return note ? (
      <p role="status" className={`mt-3 text-[12px] ${note.tone === 'good' ? 'text-good' : 'text-bad'}`}>
        {note.text}
      </p>
    ) : null
  }

  /** Viewers can select and look; the write buttons only say so (never natively disabled for them, so a click always gets the note). */
  function viewOnly(): boolean {
    if (!viewer) return false
    announceViewOnly()
    return true
  }

  async function research() {
    if (viewOnly()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/research/enqueue', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_ids: selected.companyIds }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (res.status === 404) setNote({ tone: 'bad', text: 'The research queue isn’t on this deploy yet.' })
      else if (!res.ok) setNote({ tone: 'bad', text: failedWriteText(res.status, body?.error, `Research request failed (${res.status}).`, await fetchRole()) })
      else {
        const queued = typeof body?.queued === 'number' ? body.queued : null
        setNote({ tone: 'good', text: queued === null ? 'Sent to the research queue.' : `${queued} queued for research.` })
        onDone()
        router.refresh?.()
      }
    } catch (err) {
      setNote({ tone: 'bad', text: thrownWriteText(err, await fetchRole()) })
    } finally {
      setBusy(false)
    }
  }

  async function applyStage() {
    if (viewOnly() || !stage) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/leads/stage', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_ids: selected.companyIds, stage }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) setNote({ tone: 'bad', text: failedWriteText(res.status, body?.error, `Couldn’t change the stage (${res.status}).`, await fetchRole()) })
      else {
        setNote({ tone: 'good', text: typeof body?.updated === 'number' ? `${body.updated} moved to ${STAGE_LABELS[stage]}.` : `Moved to ${STAGE_LABELS[stage]}.` })
        onDone()
        router.refresh?.()
      }
    } catch (err) {
      setNote({ tone: 'bad', text: thrownWriteText(err, await fetchRole()) })
    } finally {
      setBusy(false)
    }
  }

  /** One field, one value, every selected lead; each change goes through the inline-edit path and is logged. */
  /** "Apply to N" only asks; Confirm sends (no bulk change without a confirm that shows the count). */
  function askApplyField() {
    if (viewOnly() || !editField) return
    setNote(null)
    setConfirming(true)
  }

  async function applyField() {
    if (viewOnly() || !editField) return
    setConfirming(false)
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/leads/bulk-edit', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_ids: selected.companyIds, field: editField, value: editValue.trim() === '' ? null : editValue, confirm: true }),
      })
      const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) setNote({ tone: 'bad', text: failedWriteText(res.status, body?.error, `Couldn\u2019t edit the leads (${res.status}).`, await fetchRole()) })
      else {
        const failed = Array.isArray(body?.failed) ? body.failed.length : 0
        setNote({ tone: failed ? 'bad' : 'good', text: typeof body?.message === 'string' ? body.message : 'Saved.' })
        setEditValue('')
        onDone()
        router.refresh?.()
      }
    } catch (err) {
      setNote({ tone: 'bad', text: thrownWriteText(err, await fetchRole()) })
    } finally {
      setBusy(false)
    }
  }

  async function addToList() {
    if (viewOnly() || (!listChoice && !newListName.trim())) return
    setBusy(true)
    setNote(null)
    try {
      const body: Record<string, unknown> = { company_ids: selected.companyIds }
      if (listChoice) body.list_id = Number(listChoice)
      else body.new_list_name = newListName.trim()
      const res = await fetch('/api/leads/lists', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      const resBody = (await res.json().catch(() => null)) as Record<string, unknown> | null
      if (!res.ok) setNote({ tone: 'bad', text: failedWriteText(res.status, resBody?.error, `Couldn\u2019t add to the list (${res.status}).`, await fetchRole()) })
      else {
        const list = resBody?.list as { name?: string } | undefined
        setNote({ tone: 'good', text: `Added ${resBody?.added ?? ''} lead${resBody?.added === 1 ? '' : 's'} to \u201C${list?.name ?? 'the list'}\u201D.` })
        setListChoice('')
        setNewListName('')
        onDone()
        router.refresh?.()
      }
    } catch (err) {
      setNote({ tone: 'bad', text: thrownWriteText(err, await fetchRole()) })
    } finally {
      setBusy(false)
    }
  }

  const verifyIds = selected.unverifiedContactIds
  const fieldLabel = BULK_FIELD_CHOICES.find((f) => f.value === editField)?.label ?? editField
  return (
    <div
      role="region"
      aria-label="Selected leads"
      className="sticky bottom-3 z-20 mt-3 flex flex-wrap items-center gap-2 rounded-card border border-line bg-surface px-3 py-2 shadow-card"
    >
      <span className="mr-1 text-[12px] font-medium tabular-nums text-ink">{n} selected</span>
      <button type="button" className={`${BUTTON_PRIMARY} ${viewer ? VIEW_ONLY_DIM : ''}`} disabled={!viewer && busy} onClick={research} {...(viewer ? VIEW_ONLY_PROPS : {})}>
        Research selected
      </button>
      {verifyIds.length ? (
        <VerifyButton contactIds={verifyIds} label="Verify selected" />
      ) : (
        <span className={`${BUTTON} cursor-not-allowed opacity-50`} title="None of the selected leads has an unverified email">
          Verify selected
        </span>
      )}
      <span className="flex items-center gap-1">
        <label className="sr-only" htmlFor="bulk-list">
          Add to list
        </label>
        <select
          id="bulk-list"
          value={listChoice}
          onChange={(e) => {
            setListChoice(e.target.value)
            if (e.target.value) setNewListName('')
          }}
          className="rounded-card border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
        >
          <option value="">Add to list…</option>
          {lists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
          <option value="">New list…</option>
        </select>
        {!listChoice ? (
          <input
            value={newListName}
            onChange={(e) => setNewListName(e.target.value)}
            placeholder="New list name"
            className="w-28 rounded-card border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
          />
        ) : null}
        <button type="button" className={`${BUTTON} ${viewer ? VIEW_ONLY_DIM : ''}`} disabled={!viewer && (busy || (!listChoice && !newListName.trim()))} onClick={addToList} {...(viewer ? VIEW_ONLY_PROPS : {})}>
          Add
        </button>
      </span>
      <Link
        href={`/leads/instantly?companies=${selected.companyIds.join(',')}`}
        prefetch={false}
        className={BUTTON}
        title="Pick a campaign and preview who would be added; nothing is sent until you confirm"
      >
        Add to Instantly
      </Link>
      <span className="flex items-center gap-1">
        <label className="sr-only" htmlFor="bulk-stage">
          Set stage
        </label>
        <select
          id="bulk-stage"
          value={stage}
          onChange={(e) => setStage(e.target.value as Stage | '')}
          className="rounded-card border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
        >
          <option value="">Set stage…</option>
          {STAGES.map((s) => (
            <option key={s} value={s}>
              {STAGE_LABELS[s]}
            </option>
          ))}
        </select>
        <button type="button" className={`${BUTTON} ${viewer ? VIEW_ONLY_DIM : ''}`} disabled={!viewer && (busy || !stage)} onClick={applyStage} {...(viewer ? VIEW_ONLY_PROPS : {})}>
          Apply
        </button>
      </span>
      <span className="flex items-center gap-1">
        <label className="sr-only" htmlFor="bulk-field">
          Edit field
        </label>
        <select
          id="bulk-field"
          value={editField}
          onChange={(e) => {
            setEditField(e.target.value)
            setConfirming(false)
          }}
          className="rounded-card border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
        >
          <option value="">Edit field…</option>
          {BULK_FIELD_CHOICES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        {editField ? (
          <>
            <label className="sr-only" htmlFor="bulk-value">
              New value
            </label>
            <input
              id="bulk-value"
              value={editValue}
              onChange={(e) => {
                setEditValue(e.target.value)
                setConfirming(false)
              }}
              placeholder="Empty clears it"
              className="w-32 rounded-card border border-line bg-surface px-2 py-1.5 text-[12px] text-ink"
            />
          </>
        ) : null}
        <button type="button" className={`${BUTTON} ${viewer ? VIEW_ONLY_DIM : ''}`} disabled={!viewer && (busy || !editField)} onClick={askApplyField} {...(viewer ? VIEW_ONLY_PROPS : {})}>
          Apply to {n}
        </button>
      </span>
      {confirming && editField && !viewer ? (
        <span role="group" aria-label="Confirm bulk edit" className="flex w-full flex-wrap items-center gap-2 border-t border-line-soft pt-2 text-[12px] text-ink">
          <span className="tabular-nums">
            {editValue.trim() === ''
              ? `Clear ${fieldLabel} on ${n} lead${n === 1 ? '' : 's'}?`
              : `Set ${fieldLabel} to \u201C${editValue.trim()}\u201D on ${n} lead${n === 1 ? '' : 's'}?`}
          </span>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy} onClick={applyField}>
            Confirm
          </button>
          <button type="button" className={BUTTON} onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </span>
      ) : null}
      <button type="button" className="ml-auto text-[12px] text-ink-faint hover:text-ink" onClick={onDone}>
        Clear
      </button>
      {note ? (
        <p role="status" className={`w-full text-[12px] ${note.tone === 'good' ? 'text-good' : 'text-bad'}`}>
          {note.text}
        </p>
      ) : null}
    </div>
  )
}
