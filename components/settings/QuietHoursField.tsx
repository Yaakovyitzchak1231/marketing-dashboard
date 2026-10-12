'use client'

import { startTransition, useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { quietHoursPairError } from '@/lib/settings/quiet-hours'

type SaveAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/

/**
 * What is wrong with the saved pair, in words, or null when it is sound or wholly unset.
 * A half-saved or equal pair is not "Not set": it is stored, and the send gate holds
 * sends over it (lib/journeys/send-controls.ts), so the page says so.
 */
function storedProblem(start: string | null, end: string | null): { pill: string; text: string } | null {
  if (quietHoursPairError(start, end) === null) return null
  const a = (start ?? '').trim()
  const b = (end ?? '').trim()
  const held = 'Journeys that use the workspace quiet hours hold their sends until this is fixed.'
  if (a && !b) return { pill: 'Incomplete', text: `Incomplete: only the start (${a}) is saved. ${held}` }
  if (!a && b) return { pill: 'Incomplete', text: `Incomplete: only the end (${b}) is saved. ${held}` }
  if (HHMM.test(a) && HHMM.test(b) && a === b) {
    return { pill: 'Not valid', text: `Start and end are the same time (${a}), so there would be no quiet hours. ${held}` }
  }
  return { pill: 'Not valid', text: `The saved times (${a} to ${b}) are not both 24-hour HH:MM. ${held}` }
}

/**
 * Quiet hours as one range: "21:00 to 08:00", two time pickers, one Save that
 * writes both settings in one call through the injected pair action (fields
 * `start` and `end`, one transaction on the server). Validates HH:MM on the
 * client too.
 */
export function QuietHoursField({
  start,
  end,
  anchorStart,
  anchorEnd,
  action,
}: {
  start: string | null
  end: string | null
  anchorStart?: string
  anchorEnd?: string
  action: SaveAction
}) {
  const [s, setS] = useState(start ?? '')
  const [e, setE] = useState(end ?? '')
  const save = async (_prev: FormResult | null, f: FormData): Promise<FormResult> => {
    // Clear (the button, or saving both fields empty) goes through the same server call with both ends blank.
    const clearing = f.get('intent') === 'clear' || (!s && !e)
    if (clearing) {
      const fd = new FormData()
      fd.set('start', '')
      fd.set('end', '')
      const r = await action(null, fd)
      if (!r.ok) return r
      setS('')
      setE('')
      return { ok: true, message: 'Cleared: no workspace quiet hours.' }
    }
    if (!HHMM.test(s) || !HHMM.test(e)) return { ok: false, message: 'Pick both a start and an end time (24-hour HH:MM, e.g. 21:00), or clear both.' }
    if (s === e) return { ok: false, message: 'Start and end are the same time, so there would be no quiet hours.' }
    const fd = new FormData()
    fd.set('start', s)
    fd.set('end', e)
    const r = await action(null, fd)
    return r.ok ? { ok: true, message: `Saved: no emails from ${s} to ${e}.` } : r
  }
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(save, null)
  const problem = storedProblem(start, end)
  const isSet = !problem && Boolean(start && end)
  const canClear = Boolean(start || end) // anything stored, including a half-set or invalid pair, can be cleared
  const clear = () => {
    const fd = new FormData()
    fd.set('intent', 'clear')
    startTransition(() => formAction(fd))
  }
  const overnight = HHMM.test(s) && HHMM.test(e) && e < s
  return (
    <div id={anchorStart} className="scroll-mt-20 border-b border-line-soft py-3 last:border-b-0 target:bg-warn-soft">
      {anchorEnd ? <span id={anchorEnd} className="block scroll-mt-20" aria-hidden /> : null}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-[13px] font-medium text-ink" id="quiet-hours-label">
          Quiet hours
        </span>
        {problem ? <Pill tone="bad">{problem.pill}</Pill> : isSet ? <Pill tone="neutral">{`${start} to ${end}`}</Pill> : <Pill tone="warn">Not set</Pill>}
      </div>
      {problem ? <p className="mt-0.5 text-[12px] leading-snug text-bad">{problem.text}</p> : null}
      <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">No emails go out between these hours, in your timezone; a campaign can override.</p>
      <form action={formAction} className="mt-2 flex flex-wrap items-center gap-2" aria-labelledby="quiet-hours-label">
        <input type="time" aria-label="Quiet hours start" value={s} onChange={(ev) => setS(ev.target.value)} className={`w-[8.5rem] ${inputCls}`} />
        <span className="text-[12.5px] text-ink-muted">to</span>
        <input type="time" aria-label="Quiet hours end" value={e} onChange={(ev) => setE(ev.target.value)} className={`w-[8.5rem] ${inputCls}`} />
        <button type="submit" disabled={pending || (s === (start ?? '') && e === (end ?? ''))} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {canClear ? (
          <button type="button" onClick={clear} disabled={pending} className={btnCls}>
            Clear
          </button>
        ) : null}
        {overnight ? <span className="text-[12px] text-ink-faint">(overnight, ends the next morning)</span> : null}
      </form>
      {state ? (
        <p className={`mt-1.5 text-[12px] ${state.ok ? 'text-ink-muted' : 'text-bad'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
