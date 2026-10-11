'use client'

import { useState, useTransition } from 'react'
import { mergeAction } from '@/app/actions/merge'
import type { MergeCandidate, MergeEntity } from '@/lib/merge/candidates'
import { Card, Pill } from '@/components/dashboard/primitives'

const RULE_LABEL: Record<string, string> = { domain: 'same website', phone: 'same phone', name_addr: 'same name + address', email: 'same email' }

function Row({ label, a, b, onPick, picked }: { label: string; a: string | null; b: string | null; onPick: (v: 'keep' | 'merge') => void; picked: 'keep' | 'merge' }) {
  if (a === b) return null // nothing to pick when both sides already agree (or are both empty)
  return (
    <div className="grid grid-cols-[100px_1fr_1fr] items-center gap-2 border-b border-line-soft py-1.5 text-[12px]">
      <span className="text-ink-faint">{label}</span>
      <button type="button" onClick={() => onPick('keep')} className={`truncate rounded-[3px] px-1.5 py-1 text-left ${picked === 'keep' ? 'bg-accent-soft text-accent' : 'hover:bg-canvas'}`}>
        {a || <span className="text-unavailable">—</span>}
      </button>
      <button type="button" onClick={() => onPick('merge')} className={`truncate rounded-[3px] px-1.5 py-1 text-left ${picked === 'merge' ? 'bg-accent-soft text-accent' : 'hover:bg-canvas'}`}>
        {b || <span className="text-unavailable">—</span>}
      </button>
    </div>
  )
}

const FIELDS: { key: string; label: string }[] =
  [{ key: 'name', label: 'Name' }, { key: 'website', label: 'Website' }, { key: 'phone', label: 'Phone' }, { key: 'city', label: 'City' }, { key: 'state', label: 'State' }]

function PairCard({ entity, cand, onMerged }: { entity: MergeEntity; cand: MergeCandidate; onMerged: (a: number, b: number) => void }) {
  const [keepSide, setKeepSide] = useState<'a' | 'b'>('a')
  const [choices, setChoices] = useState<Record<string, 'keep' | 'merge'>>({})
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const keep = keepSide === 'a' ? cand.a : cand.b
  const loser = keepSide === 'a' ? cand.b : cand.a

  function doMerge() {
    setError(null)
    startTransition(async () => {
      const r = await mergeAction({ entity, keep: keep.id, merge: loser.id, choices })
      if (!r.ok) {
        setError(r.error)
        return
      }
      onMerged(cand.a.id, cand.b.id)
    })
  }

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex flex-wrap gap-1">
          {cand.rules.map((r) => (
            <Pill key={r} tone="neutral">{RULE_LABEL[r] ?? r}</Pill>
          ))}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-ink-faint">
          Keep:
          <button type="button" onClick={() => setKeepSide('a')} className={`rounded-full border px-2 py-0.5 ${keepSide === 'a' ? 'border-accent text-accent' : 'border-line'}`}>#{cand.a.id}</button>
          <button type="button" onClick={() => setKeepSide('b')} className={`rounded-full border px-2 py-0.5 ${keepSide === 'b' ? 'border-accent text-accent' : 'border-line'}`}>#{cand.b.id}</button>
        </div>
      </div>
      <div className="grid grid-cols-[100px_1fr_1fr] gap-2 border-b border-line pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-faint">
        <span />
        <span>Keep (#{keep.id})</span>
        <span>Merge away (#{loser.id})</span>
      </div>
      {FIELDS.map((f) => {
        const keepVal = (keep as unknown as Record<string, string | null>)[f.key]
        const loserVal = (loser as unknown as Record<string, string | null>)[f.key]
        const picked = choices[f.key] ?? 'keep'
        return (
          <Row
            key={f.key}
            label={f.label}
            a={keepVal}
            b={loserVal}
            picked={picked}
            onPick={(v) => setChoices((c) => ({ ...c, [f.key]: v }))}
          />
        )
      })}
      <div className="mt-3 flex items-center gap-2">
        <button type="button" disabled={pending} onClick={doMerge} className="rounded-card border border-accent bg-accent px-2.5 py-1.5 text-[12px] font-medium text-white hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50">
          {pending ? 'Merging…' : `Merge #${loser.id} into #${keep.id}`}
        </button>
        {error ? <span role="alert" className="text-[12px] text-bad">{error}</span> : null}
      </div>
    </Card>
  )
}

export function DuplicatesClient({ entity, initial }: { entity: MergeEntity; initial: MergeCandidate[] }) {
  const [candidates, setCandidates] = useState(initial)
  if (!candidates.length) return <p className="px-1 py-8 text-center text-[13px] text-ink-faint">No likely duplicates found right now.</p>
  return (
    <div className="flex flex-col gap-3">
      {candidates.map((c) => (
        <PairCard
          key={`${c.a.id}-${c.b.id}`}
          entity={entity}
          cand={c}
          onMerged={(a, b) => setCandidates((cs) => cs.filter((x) => !(x.a.id === a && x.b.id === b)))}
        />
      ))}
    </div>
  )
}
