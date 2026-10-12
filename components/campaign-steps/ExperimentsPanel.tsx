'use client'

/**
 * A/B experiments on a campaign's steps (plan 3.6): create an experiment for
 * a step (variants + weights + auto-winner), record outcomes, evaluate, and
 * see per-variant results with the current winner.
 */
import { useCallback, useEffect, useState } from 'react'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { INPUT, LABEL } from '@/components/campaigns/ui'
import { call } from './api'
import { formatPct } from '@/components/dashboard/format'
import { formatPercent } from '@/components/charts/format'

interface VariantCfg { key: string; weight: number }
interface Outcome { variant: string; sends: number; replies: number }
interface Experiment {
  id: number
  campaign_id: number
  step_number: number
  name: string
  status: 'draft' | 'running' | 'paused' | 'decided'
  config: { variants: VariantCfg[]; auto_winner: boolean; min_sends_per_variant: number }
  winner_variant: string | null
  decided_at: string | null
}
interface Detail extends Experiment { outcomes: Outcome[]; assignments: number }

const tone = (s: Experiment['status']) =>
  s === 'running' ? 'good' : s === 'decided' ? 'accent' : s === 'paused' ? 'warn' : 'neutral'

export function ExperimentsPanel({ campaignId, stepNumbers }: { campaignId: number; stepNumbers: number[] }) {
  const [list, setList] = useState<Experiment[] | null>(null)
  const [detail, setDetail] = useState<Record<number, Detail>>({})
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // create form
  const [step, setStep] = useState(stepNumbers[0] ?? 1)
  const [name, setName] = useState('')
  const [variants, setVariants] = useState('A:50, B:50')
  const [autoWinner, setAutoWinner] = useState(true)
  // outcome form, per experiment
  const [oc, setOc] = useState<Record<number, { variant: string; sends: string; replies: string }>>({})

  const load = useCallback(async () => {
    const r = await call(campaignId, '/experiments', 'GET')
    if (r.ok) setList((r.experiments as Experiment[]) ?? [])
    else setError(r.error ?? 'Could not load experiments.')
  }, [campaignId])

  useEffect(() => { void load() }, [load])

  const act = async (path: string, method: string, body?: unknown) => {
    setBusy(true)
    setError(null)
    const r = await call(campaignId, path, method, body)
    setBusy(false)
    if (!r.ok) { setError(r.error ?? 'That did not work.'); return null }
    return r
  }

  const open = async (id: number) => {
    const r = await act(`/experiments/${id}`, 'GET')
    if (r) setDetail((d) => ({ ...d, [id]: r as unknown as Detail }))
  }

  const parseVariants = (s: string): VariantCfg[] =>
    s.split(',').map((p) => p.trim()).filter(Boolean).map((p) => {
      const [k, w] = p.split(':').map((x) => x.trim())
      return { key: k, weight: Number(w) }
    })

  const create = async () => {
    const r = await act('/experiments', 'POST', {
      step_number: step,
      name: name.trim(),
      config: { variants: parseVariants(variants), auto_winner: autoWinner },
    })
    if (r) { setName(''); setVariants('A:50, B:50'); await load() }
  }

  const setStatus = async (id: number, status: string) => {
    const r = await act(`/experiments/${id}`, 'PATCH', { status })
    if (r) { await load(); await open(id) }
  }

  const evaluate = async (id: number) => {
    const r = await act(`/experiments/${id}/evaluate`, 'POST')
    if (r) {
      const ev = r as unknown as { reason: string; decided: boolean }
      setError(ev.decided ? null : `Not decided yet: ${ev.reason}`)
      await load(); await open(id)
    }
  }

  const record = async (id: number) => {
    const f = oc[id] ?? { variant: 'A', sends: '', replies: '' }
    const toNum = (v: string): number | undefined => {
      const n = Number(v)
      return v.trim() === '' || !Number.isFinite(n) ? undefined : n
    }
    const r = await act(`/experiments/${id}/outcome`, 'POST', {
      variant: f.variant, sends: toNum(f.sends), replies: toNum(f.replies),
    })
    if (r) { setOc((o) => ({ ...o, [id]: { variant: f.variant, sends: '', replies: '' } })); await open(id) }
  }

  return (
    <section aria-labelledby="exp-h" className="mt-6">
      <SectionHeader id="exp-h" title="A/B experiments" meta="Split a step's traffic across variants; the winner can be picked automatically once the numbers are significant" />
      {error ? <p role="alert" className="mb-2 text-[12px] text-bad">{error}</p> : null}
      {!list ? <EmptyNote>Loading experiments…</EmptyNote> : null}
      {list && !list.length ? <EmptyNote>No experiments yet. Create one below to A/B test a step.</EmptyNote> : null}
      <div className="space-y-3">
        {(list ?? []).map((e) => {
          const d = detail[e.id]
          const total = e.config.variants.reduce((s, v) => s + v.weight, 0)
          return (
            <Card key={e.id} className="p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">Step {e.step_number}: {e.name}</span>
                <Pill tone={tone(e.status)}>{e.status}</Pill>
                {e.winner_variant ? <Pill tone="good">Winner: {e.winner_variant}</Pill> : null}
                <span className="ml-auto flex gap-1">
                  <button type="button" className={BUTTON} disabled={busy} onClick={() => open(e.id)}>Results</button>
                  {e.status === 'draft' ? <button type="button" className={BUTTON} disabled={busy} onClick={() => setStatus(e.id, 'running')}>Start</button> : null}
                  {e.status === 'running' ? <button type="button" className={BUTTON} disabled={busy} onClick={() => setStatus(e.id, 'paused')}>Pause</button> : null}
                  {e.status === 'paused' ? <button type="button" className={BUTTON} disabled={busy} onClick={() => setStatus(e.id, 'running')}>Resume</button> : null}
                  {e.status === 'running' ? <button type="button" className={BUTTON} disabled={busy} onClick={() => evaluate(e.id)}>Evaluate now</button> : null}
                </span>
              </div>
              <p className="mt-1 text-[12px] text-ink-muted">
                {e.config.variants.map((v) => `${v.key} (${formatPercent(v.weight / total, 0)})`).join(' · ')}
                {' '}· auto-winner {e.config.auto_winner ? 'on' : 'off'} · min {e.config.min_sends_per_variant} sends/variant
              </p>
              {d ? (
                <div className="mt-3 border-t border-line pt-2">
                  <table className="w-full text-[12px]">
                    <thead><tr className="text-left text-ink-muted"><th>Variant</th><th>Sends</th><th>Positive replies</th><th>Reply rate</th></tr></thead>
                    <tbody>
                      {d.outcomes.map((o) => (
                        <tr key={o.variant}>
                          <td className="font-semibold">{o.variant}{d.winner_variant === o.variant ? ' ★' : ''}</td>
                          <td>{o.sends.toLocaleString()}</td><td>{o.replies.toLocaleString()}</td>
                          <td>{formatPct(o.sends ? o.replies / o.sends : null)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="mt-1 text-[12px] text-ink-muted">{d.assignments.toLocaleString()} leads assigned{d.decided_at ? ` · decided ${new Date(d.decided_at).toLocaleString()}` : ''}</p>
                  {e.status === 'running' ? (
                    <div className="mt-2 flex flex-wrap items-end gap-2">
                      <label className={LABEL}>Variant
                        <select className={INPUT} value={(oc[e.id] ?? { variant: e.config.variants[0]?.key ?? 'A' }).variant}
                          onChange={(e2) => setOc((o) => ({ ...o, [e.id]: { ...(o[e.id] ?? { sends: '', replies: '' }), variant: e2.target.value } }))}>
                          {e.config.variants.map((v) => <option key={v.key} value={v.key}>{v.key}</option>)}
                        </select>
                      </label>
                      <label className={LABEL}>Sends<input className={INPUT} inputMode="numeric"
                        value={(oc[e.id] ?? { sends: '' }).sends}
                        onChange={(e2) => setOc((o) => ({ ...o, [e.id]: { ...(o[e.id] ?? { variant: 'A', replies: '' }), sends: e2.target.value } }))} /></label>
                      <label className={LABEL}>Positive replies<input className={INPUT} inputMode="numeric"
                        value={(oc[e.id] ?? { replies: '' }).replies}
                        onChange={(e2) => setOc((o) => ({ ...o, [e.id]: { ...(o[e.id] ?? { variant: 'A', sends: '' }), replies: e2.target.value } }))} /></label>
                      <button type="button" className={BUTTON} disabled={busy} onClick={() => record(e.id)}>Record</button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </Card>
          )
        })}
      </div>
      <Card className="mt-3 p-3">
        <h3 className="mb-2 text-[13px] font-semibold">New experiment</h3>
        <div className="flex flex-wrap items-end gap-2">
          <label className={LABEL}>Step
            <select className={INPUT} value={step} onChange={(e) => setStep(Number(e.target.value))}>
              {stepNumbers.map((n) => <option key={n} value={n}>Step {n}</option>)}
            </select>
          </label>
          <label className={LABEL}>Name<input className={INPUT} value={name} maxLength={120}
            placeholder="e.g. Subject line test" onChange={(e) => setName(e.target.value)} /></label>
          <label className={LABEL}>Variants (key:weight, comma-separated)<input className={INPUT} value={variants}
            onChange={(e) => setVariants(e.target.value)} placeholder="A:50, B:50" /></label>
          <label className="flex items-center gap-2 text-[12px] text-ink-muted">
            <input type="checkbox" checked={autoWinner} onChange={(e) => setAutoWinner(e.target.checked)} /> Auto-pick winner
          </label>
          <button type="button" className={BUTTON_PRIMARY} disabled={busy || !name.trim()} onClick={create}>Create</button>
        </div>
      </Card>
    </section>
  )
}
