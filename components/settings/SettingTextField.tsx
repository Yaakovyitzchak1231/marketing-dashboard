'use client'

import { useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { inputCls, primaryBtnCls } from '@/components/ops/bits'

type SaveAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

/** One non-secret setting: label, current value, inline edit (a dropdown when the setting has fixed options), Save. The action is injected (like PauseControl's), so this component has no server-only import chain of its own. */
export function SettingTextField({
  settingKey,
  label,
  help,
  value,
  source,
  placeholder,
  multiline,
  options,
  anchorId,
  action,
}: {
  settingKey: string
  label: string
  help?: string
  value: string | null
  source: 'db' | 'env' | 'unset'
  placeholder?: string
  multiline?: boolean
  /** A fixed set of choices: renders a dropdown instead of a text box. */
  options?: { value: string; label: string }[]
  /** The row's id, so the "Needs setup" list at the top can link straight to it. */
  anchorId?: string
  action: SaveAction
}) {
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(action, null)
  const [draft, setDraft] = useState(value ?? '')
  const fieldCls = `min-w-0 flex-1 ${inputCls} ${multiline ? 'font-mono text-xs' : ''}`
  const ph = placeholder ?? (source === 'env' ? 'Set via env for now' : 'Not set')
  return (
    <div id={anchorId} className="scroll-mt-20 border-b border-line-soft py-3 last:border-b-0 target:bg-warn-soft">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={settingKey} className="text-sm font-medium text-ink">
          {label}
        </label>
        {source === 'env' ? <Pill tone="neutral">from env</Pill> : source === 'unset' && !value ? <Pill tone="warn">Not set</Pill> : null}
      </div>
      {help ? <p className="mt-0.5 text-xs leading-snug text-ink-faint">{help}</p> : null}
      <form action={formAction} className="mt-2 flex flex-wrap items-start gap-2">
        <input type="hidden" name="key" value={settingKey} />
        {options ? (
          <select id={settingKey} name="value" value={draft} onChange={(e) => setDraft(e.target.value)} className={fieldCls}>
            <option value="" disabled>
              {source === 'env' ? 'Set via env for now — choose to save here' : 'Choose…'}
            </option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
            {draft && !options.some((o) => o.value === draft) ? <option value={draft}>{draft}</option> : null}
          </select>
        ) : multiline ? (
          <textarea id={settingKey} name="value" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={ph} rows={3} className={fieldCls} />
        ) : (
          <input id={settingKey} name="value" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={ph} className={fieldCls} />
        )}
        <button type="submit" disabled={pending || draft === (value ?? '')} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
      {state ? (
        <p className={`mt-1.5 text-xs ${state.ok ? 'text-ink-muted' : 'text-bad'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
