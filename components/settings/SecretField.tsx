'use client'

import { useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { secretSummary } from '@/lib/settings/mask'

export interface SecretFieldStatus {
  set: boolean
  last4: string | null
  updated_at: string | null
  updated_by: string | null
}

type FormAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

/**
 * A secret field: the value itself never reaches this component, only its
 * status. Replace (password input, never prefilled), Clear, and Test when the
 * registry has one. Actions are injected the way PauseControl takes its
 * actions, so this component carries no server-only import chain.
 */
export function SecretField({
  settingKey,
  label,
  help,
  status,
  envConfigured,
  envLast4 = null,
  envSeenAt = null,
  timeZone,
  testable,
  settingsKeyReady,
  replaceAction,
  clearAction,
  testAction,
}: {
  settingKey: string
  label: string
  help?: string
  status: SecretFieldStatus
  envConfigured: boolean
  /** Last 4 characters of the env fallback's value (computed server-side; only these 4 reach the client). */
  envLast4?: string | null
  /** When the dashboard first saw the env value (lp.env_secret_seen), ISO. */
  envSeenAt?: string | null
  /** Workspace timezone for the "set" time. */
  timeZone?: string
  testable: boolean
  settingsKeyReady: boolean
  replaceAction: FormAction
  clearAction: FormAction
  testAction: FormAction
}) {
  const [replacing, setReplacing] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)
  const [replaceState, replaceFormAction, replacePending] = useActionState<FormResult | null, FormData>(replaceAction, null)
  const [clearState, clearFormAction, clearPending] = useActionState<FormResult | null, FormData>(clearAction, null)
  const [testState, testFormAction, testPending] = useActionState<FormResult | null, FormData>(testAction, null)
  const summary = status.set
    ? secretSummary({ source: 'db', last4: status.last4, at: status.updated_at, by: status.updated_by, timeZone })
    : envConfigured
      ? secretSummary({ source: 'env', last4: envLast4, at: envSeenAt, timeZone })
      : null

  return (
    <div className="border-b border-line-soft py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">{label}</span>
        {summary ? (
          <Pill tone={status.set ? 'good' : 'neutral'}>{summary.badge}</Pill>
        ) : (
          <Pill tone="neutral">Not set</Pill>
        )}
      </div>
      {help ? <p className="mt-0.5 text-xs leading-snug text-ink-faint">{help}</p> : null}
      {summary?.line ? <p className="mt-1 text-xs text-ink-faint" suppressHydrationWarning>{summary.line}</p> : null}

      {!settingsKeyReady ? (
        <p className="mt-2 text-xs text-warn">Add SETTINGS_KEY in Vercel to enable saving secrets here (see the deploy note). Until then this field is read-only.</p>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {!replacing ? (
            <button type="button" className={btnCls} onClick={() => setReplacing(true)}>
              Replace
            </button>
          ) : null}
          {status.set && !confirmClear ? (
            <button type="button" className={btnCls} onClick={() => setConfirmClear(true)}>
              Clear
            </button>
          ) : null}
          {status.set && testable ? (
            <form action={testFormAction}>
              <input type="hidden" name="key" value={settingKey} />
              <button type="submit" disabled={testPending} className={btnCls}>
                {testPending ? 'Testing…' : 'Test'}
              </button>
            </form>
          ) : null}
        </div>
      )}

      {replacing ? (
        <form action={replaceFormAction} className="mt-2 flex flex-wrap items-start gap-2">
          <input type="hidden" name="key" value={settingKey} />
          <input type="password" name="value" autoComplete="new-password" placeholder="Paste the new value" className={`min-w-0 flex-1 ${inputCls}`} />
          <button type="submit" disabled={replacePending} className={primaryBtnCls}>
            Save
          </button>
          <button type="button" className={btnCls} onClick={() => setReplacing(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {confirmClear ? (
        <form action={clearFormAction} className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-warn/30 bg-warn-soft px-2.5 py-1.5">
          <input type="hidden" name="key" value={settingKey} />
          <input type="hidden" name="confirm" value="yes" />
          <span className="text-xs text-warn">Remove this secret? Anything that uses it falls back to env, if set, or stops working.</span>
          <button type="submit" disabled={clearPending} className={primaryBtnCls} onClick={() => setConfirmClear(false)}>
            Clear it
          </button>
          <button type="button" className={btnCls} onClick={() => setConfirmClear(false)}>
            Cancel
          </button>
        </form>
      ) : null}

      {replaceState ? (
        <p className={`mt-1.5 text-xs ${replaceState.ok ? 'text-good' : 'text-bad'}`} role="status">
          {replaceState.message}
        </p>
      ) : null}
      {clearState ? (
        <p className={`mt-1.5 text-xs ${clearState.ok ? 'text-good' : 'text-bad'}`} role="status">
          {clearState.message}
        </p>
      ) : null}
      {testState ? (
        <p className={`mt-1.5 text-xs ${testState.ok ? 'text-good' : 'text-bad'}`} role="status">
          {testState.message}
        </p>
      ) : null}
    </div>
  )
}
