'use client'

import { useActionState } from 'react'
import { inputCls, primaryBtnCls } from '@/components/ops/bits'
import type { ImportSummary } from '@/lib/leads/csv-import'

type ActionResult = ({ ok: true } & ImportSummary) | { ok: false; error: string }

export function AddLeadForm({
  action,
  pools,
  campaigns,
}: {
  action: (f: FormData) => Promise<ActionResult>
  pools: { id: string; label: string }[]
  campaigns: { id: number; name: string }[]
}) {
  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(async (_prev, formData) => action(formData), null)

  return (
    <form action={formAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <input name="first_name" placeholder="First name" className={inputCls} />
      <input name="last_name" placeholder="Last name" className={inputCls} />
      <input name="email" type="email" placeholder="Email (or leave blank with a phone below)" className={inputCls} />
      <input name="phone" placeholder="Phone" className={inputCls} />
      <input name="title" placeholder="Title" className={inputCls} />
      <input name="company_name" placeholder="Company name" className={inputCls} />
      <input name="website" placeholder="Website" className={inputCls} />
      <input name="company_phone" placeholder="Company phone" className={inputCls} />
      <input name="city" placeholder="City" className={inputCls} />
      <input name="state" placeholder="State" className={inputCls} />
      <select name="pool" defaultValue="" className={inputCls}>
        <option value="">No pool</option>
        {pools.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <select name="campaign_id" defaultValue="" className={inputCls}>
        <option value="">No campaign</option>
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </select>
      <div className="sm:col-span-2">
        <button type="submit" disabled={pending} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Add lead'}
        </button>
      </div>
      {state ? (
        state.ok ? (
          <p className="sm:col-span-2 text-xs text-ink-muted">
            {state.would_create ? 'Created.' : state.would_update ? 'Matched an existing lead and updated it.' : state.skipped_suppressed ? 'Skipped: that email is suppressed.' : 'Nothing to add -- give at least an email or a phone.'}
          </p>
        ) : (
          <p className="sm:col-span-2 text-xs text-warn">{state.error}</p>
        )
      ) : null}
    </form>
  )
}
