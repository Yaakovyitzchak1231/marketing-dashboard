'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { STAGES, type Stage } from '@/lib/leads/types'
import { STAGE_LABELS } from '@/lib/leads/filters'

/** Moving a card: a small stage select (no drag library). Saves on change. */
export function StageSelect({ companyId, stage, name }: { companyId: number; stage: Stage; name: string }) {
  const router = useRouter()
  const [value, setValue] = useState<Stage>(stage)
  const [state, setState] = useState<'idle' | 'saving' | 'error'>('idle')

  async function change(next: Stage) {
    const prev = value
    setValue(next)
    setState('saving')
    try {
      const res = await fetch('/api/leads/stage', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ company_ids: [companyId], stage: next }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setState('idle')
      router.refresh?.()
    } catch {
      setValue(prev)
      setState('error')
    }
  }

  return (
    <span className="inline-flex items-center gap-1.5">
      <label className="sr-only" htmlFor={`stage-${companyId}`}>
        Stage for {name}
      </label>
      <select
        id={`stage-${companyId}`}
        value={value}
        disabled={state === 'saving'}
        onChange={(e) => change(e.target.value as Stage)}
        className="max-w-[130px] rounded-[3px] border border-line bg-canvas px-1.5 py-0.5 text-[11px] text-ink-muted"
      >
        {STAGES.map((s) => (
          <option key={s} value={s}>
            {STAGE_LABELS[s]}
          </option>
        ))}
      </select>
      {state === 'error' ? <span className="text-[11px] text-bad">Not saved</span> : null}
    </span>
  )
}
