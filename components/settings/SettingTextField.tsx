'use client'

import { useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { inputCls, primaryBtnCls } from '@/components/ops/bits'

type SaveAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

/** One non-secret setting: label, current value, inline edit, Save. The action is injected (like PauseControl's), so this component has no server-only import chain of its own. */
export function SettingTextField({
  settingKey,
  label,
  help,
  value,
  source,
  placeholder,
  multiline,
  action,
}: {
  settingKey: string
  label: string
  help?: string
  value: string | null
  source: 'db' | 'env' | 'unset'
  placeholder?: string
  multiline?: boolean
  action: SaveAction
}) {
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(action, null)
  const [draft, setDraft] = useState(value ?? '')
  const fieldCls = `min-w-0 flex-1 ${inputCls} ${multiline ? 'font-mono text-[12px]' : ''}`
  const ph = placeholder ?? (source === 'env' ? 'Set via env for now' : 'Not set')
  return (
    <div className="border-b border-line-soft py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={settingKey} className="text-[13px] font-medium text-ink">
          {label}
        </label>
        {source === 'env' ? <Pill tone="neutral">from env</Pill> : null}
      </div>
      {help ? <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">{help}</p> : null}
      <form action={formAction} className="mt-2 flex flex-wrap items-start gap-2">
        <input type="hidden" name="key" value={settingKey} />
        {multiline ? (
          <textarea id={settingKey} name="value" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={ph} rows={3} className={fieldCls} />
        ) : (
          <input id={settingKey} name="value" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={ph} className={fieldCls} />
        )}
        <button type="submit" disabled={pending || draft === (value ?? '')} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
      {state ? (
        <p className={`mt-1.5 text-[12px] ${state.ok ? 'text-ink-muted' : 'text-bad'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
