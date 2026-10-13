'use client'

import { useActionState, useEffect, useState, useTransition } from 'react'
import type { FormResult } from '@/app/actions/settings'
import type { ModelListResult } from '@/lib/settings/models'
import { Pill } from '@/components/dashboard/primitives'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'

type SaveAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

const TYPE_OWN = '__type_own__'

/**
 * The AI model setting: once a provider base URL is set, the provider's own
 * model list is fetched (server-side, through `loadModels`) into a dropdown.
 * "Type a model name" stays available for anything not in the list, or when
 * the list can't be fetched. Saves through the same action as any setting.
 */
export function ModelPicker({
  settingKey,
  label,
  help,
  value,
  source,
  placeholder,
  providerReady,
  action,
  loadModels,
}: {
  settingKey: string
  label: string
  help?: string
  value: string | null
  source: 'db' | 'env' | 'unset'
  placeholder?: string
  /** A base URL is set (db or env), so asking the provider makes sense. */
  providerReady: boolean
  action: SaveAction
  loadModels: () => Promise<ModelListResult>
}) {
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(action, null)
  const [models, setModels] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()
  const [draft, setDraft] = useState(value ?? '')
  const [typing, setTyping] = useState(!providerReady)

  const load = () => {
    startLoading(async () => {
      const r = await loadModels()
      if (r.ok) {
        setModels(r.models)
        setLoadError(null)
        // A saved model the provider no longer lists still shows, in the text box.
        if (draft && !r.models.includes(draft)) setTyping(true)
        else setTyping(false)
      } else {
        setModels(null)
        setLoadError(r.message)
        setTyping(true)
      }
    })
  }

  useEffect(() => {
    if (providerReady) load()
    // Load once on mount; "Refresh list" reloads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerReady])

  const showSelect = providerReady && models && models.length > 0 && !typing

  return (
    <div className="border-b border-line-soft py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <label htmlFor={settingKey} className="text-sm font-medium text-ink">
          {label}
        </label>
        {source === 'env' ? <Pill tone="neutral">from env</Pill> : null}
      </div>
      {help ? <p className="mt-0.5 text-xs leading-snug text-ink-faint">{help}</p> : null}
      <form action={formAction} className="mt-2 flex flex-wrap items-start gap-2">
        <input type="hidden" name="key" value={settingKey} />
        {showSelect ? (
          <select
            id={settingKey}
            name="value"
            value={draft}
            onChange={(e) => {
              if (e.target.value === TYPE_OWN) {
                setTyping(true)
                return
              }
              setDraft(e.target.value)
            }}
            className={`min-w-0 flex-1 ${inputCls}`}
          >
            <option value="" disabled>
              Pick a model ({models.length} available)
            </option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
            <option value={TYPE_OWN}>Type a model name…</option>
          </select>
        ) : (
          <input
            id={settingKey}
            name="value"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={placeholder ?? 'Type a model name'}
            className={`min-w-0 flex-1 ${inputCls}`}
          />
        )}
        <button type="submit" disabled={pending || !draft.trim() || draft === (value ?? '')} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Save'}
        </button>
      </form>
      <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-ink-faint">
        {!providerReady ? <span>Set the AI provider base URL above to pick from its model list.</span> : null}
        {providerReady && loading ? <span>Loading the provider’s models…</span> : null}
        {providerReady && !loading && loadError ? <span className="text-warn">{loadError} You can type a model name instead.</span> : null}
        {providerReady && !loading && models?.length && typing ? (
          <button type="button" className={btnCls} onClick={() => setTyping(false)}>
            Pick from the list
          </button>
        ) : null}
        {providerReady && !loading ? (
          <button type="button" className={btnCls} onClick={load}>
            Refresh list
          </button>
        ) : null}
      </div>
      {state ? (
        <p className={`mt-1.5 text-xs ${state.ok ? 'text-ink-muted' : 'text-bad'}`} role="status">
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
