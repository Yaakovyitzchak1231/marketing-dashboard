'use client'

import { useState, useTransition } from 'react'
import { btnCls, inputCls } from '@/components/ops/bits'
import type { SegmentPreset } from '@/lib/segments/presets'
import { createFromPresetAction } from '@/app/actions/segments'

export function StartFromTemplate({ presets, campaigns }: { presets: SegmentPreset[]; campaigns: { id: number; name: string }[] }) {
  const [key, setKey] = useState(presets[0]?.key ?? '')
  const [campaignId, setCampaignId] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function create() {
    setError(null)
    startTransition(async () => {
      const r = await createFromPresetAction(key, campaignId ? Number(campaignId) : null)
      if (r.ok) window.location.href = `/segments/${r.data.id}`
      else setError(r.error)
    })
  }

  if (!presets.length) return null

  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[12px] text-ink-muted">
        Template
        <select className={inputCls} value={key} onChange={(e) => setKey(e.target.value)}>
          {['Starter', 'RFM'].map((group) => (
            <optgroup key={group} label={group === 'RFM' ? 'B2B RFM' : group}>
              {presets.filter((p) => p.group === group).map((p) => (
                <option key={p.key} value={p.key} title={p.description}>{p.label}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </label>
      <label className="text-[12px] text-ink-muted">
        Campaign scope
        <select className={inputCls} value={campaignId} onChange={(e) => setCampaignId(e.target.value)}>
          <option value="">All campaigns</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <button type="button" className={btnCls} disabled={pending || !key} onClick={create}>
        {pending ? 'Creating…' : 'Create from template'}
      </button>
      {error ? <p role="alert" className="text-[12px] text-bad">{error}</p> : null}
    </div>
  )
}
