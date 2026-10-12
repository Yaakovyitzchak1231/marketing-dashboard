'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { BUTTON_PRIMARY } from '@/components/app/PageShell'
import { fetchRole, useRole } from '@/components/auth/useRole'
import { VIEW_ONLY_DIM, VIEW_ONLY_PROPS, announceViewOnly, failedWriteText, thrownWriteText } from '@/components/auth/viewOnly'

export interface EditField {
  name: string
  label: string
  value: string | null
  type?: 'text' | 'email' | 'tel' | 'url' | 'select'
  options?: readonly string[]
}

/**
 * A plain "Edit" toggle that opens a small form for one lead's company or one
 * contact. Sends only the fields that changed (PATCH), shows the server's error
 * as-is, and refreshes the page so the history shows the new rows.
 */
export function EditFields({
  endpoint,
  title,
  fields,
  confirmEmailChange = false,
}: {
  endpoint: string
  title: string
  fields: EditField[]
  /** Ask before saving a changed email (it resets the address's verification). */
  confirmEmailChange?: boolean
}) {
  const router = useRouter()
  const initial = Object.fromEntries(fields.map((f) => [f.name, f.value ?? '']))
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<Record<string, string>>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewer = useRole() === 'viewer'

  function close() {
    setOpen(false)
    setValues(initial)
    setError(null)
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const changed = Object.fromEntries(
      fields.filter((f) => (values[f.name] ?? '').trim() !== (f.value ?? '').trim()).map((f) => [f.name, values[f.name].trim() || null]),
    )
    if (!Object.keys(changed).length) {
      close()
      return
    }
    if (
      confirmEmailChange &&
      'email' in changed &&
      !window.confirm('Changing the email resets its verification. It will need checking again before it can be sent. Save?')
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(endpoint, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(changed),
      })
      const json = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) setError(failedWriteText(res.status, json?.error, `Not saved (${res.status}).`, await fetchRole()))
      else {
        setOpen(false)
        router.refresh?.()
      }
    } catch (err) {
      setError(thrownWriteText(err, await fetchRole(), 'Not saved.'))
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => (viewer ? announceViewOnly() : setOpen(true))}
        className={`text-[12px] text-accent ${viewer ? VIEW_ONLY_DIM : 'hover:underline'}`}
        aria-label={`Edit ${title}`}
        {...(viewer ? VIEW_ONLY_PROPS : {})}
      >
        Edit
      </button>
    )
  }

  const input = 'w-full rounded-[3px] border border-line bg-surface px-2 py-1 text-[13px] text-ink'
  return (
    <form onSubmit={submit} data-write className="w-full basis-full rounded-card border border-line-soft bg-canvas p-3" aria-label={`Edit ${title}`}>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
        {fields.map((f) => {
          const id = `${endpoint}-${f.name}`.replace(/[^a-z0-9-]/gi, '-')
          return (
            <label key={f.name} htmlFor={id} className="flex flex-col gap-1 text-[12px] text-ink-muted">
              {f.label}
              {f.type === 'select' ? (
                <select id={id} value={values[f.name]} onChange={(e) => setValues({ ...values, [f.name]: e.target.value })} className={input}>
                  {(f.options ?? []).map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={id}
                  type={f.type ?? 'text'}
                  value={values[f.name]}
                  onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                  className={input}
                />
              )}
            </label>
          )
        })}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button type="submit" className={BUTTON_PRIMARY} disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button type="button" onClick={close} className="text-[12px] text-ink-faint hover:text-ink" disabled={busy}>
          Cancel
        </button>
        {error ? (
          <span role="alert" className="text-[12px] text-bad">
            {error}
          </span>
        ) : null}
      </div>
    </form>
  )
}
