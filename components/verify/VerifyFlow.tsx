'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { RunRow } from '@/lib/verify/runs'
import type { LeadFilter } from '@/lib/verify/select'
import { parseCeiling, suggestCeiling } from '@/lib/verify/pricing'
import { Card, Pill, SectionHeader } from '@/components/dashboard/primitives'

type Phase = 'idle' | 'previewing' | 'preview' | 'approving' | 'running' | 'paused' | 'finished'

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `$${n === 0 || Math.abs(n) >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`
const count = (n: number | null | undefined) => (n == null ? '—' : n.toLocaleString('en-US'))


async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}) })
  const json = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(json.error ?? `Request failed (${res.status})`)
  return json
}

const FIELDS: { key: keyof LeadFilter; label: string; placeholder: string; options?: string[] }[] = [
  { key: 'state', label: 'State', placeholder: 'MD' },
  { key: 'stage', label: 'Stage', placeholder: 'any', options: ['', 'new', 'researched', 'ready', 'in_campaign', 'contacted', 'replied', 'interested', 'meeting', 'won', 'lost'] },
  { key: 'verification_status', label: 'Email status', placeholder: 'any', options: ['', 'unverified', 'valid', 'invalid', 'catch_all', 'unknown', 'risky'] },
  { key: 'segment', label: 'Pool', placeholder: 'any pool id, e.g. jeweler' },
  { key: 'q', label: 'Search', placeholder: 'name, email, city, domain' },
]

export function VerifyFlow({
  initialIds,
  initialFilter,
  initialRun,
  keys,
}: {
  initialIds: number[]
  initialFilter: LeadFilter
  initialRun: RunRow | null
  keys: { millionverifier: boolean; zerobounce: boolean }
}) {
  const router = useRouter()
  const [ids, setIds] = useState<number[]>(initialIds)
  const [filter, setFilter] = useState<LeadFilter>(initialFilter)
  const [limit, setLimit] = useState(200)
  const [force, setForce] = useState(false)
  const [run, setRun] = useState<RunRow | null>(initialRun)
  const [ceiling, setCeiling] = useState<string>(
    initialRun?.max_cost_usd != null
      ? String(initialRun.max_cost_usd)
      : initialRun?.status === 'preview'
        ? suggestCeiling(initialRun.est_cost_usd)
        : '',
  )
  const [phase, setPhase] = useState<Phase>(() => phaseOf(initialRun))
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(initialRun?.summary?.paused ?? null)
  const stopRef = useRef(false)

  const runSteps = useCallback(
    async (runId: number) => {
      stopRef.current = false
      setPhase('running')
      setNote(null)
      try {
        for (;;) {
          if (stopRef.current) return
          const r = await post<{ run: RunRow; done: boolean; paused: string | null; halted: string | null; processed_now: number }>(
            `/api/verify/runs/${runId}/step`,
            {},
          )
          setRun(r.run)
          if (r.done || r.halted || r.run.status === 'done' || r.run.status === 'failed') {
            setPhase('finished')
            if (r.halted) setNote(r.halted)
            router.refresh()
            return
          }
          if (r.paused) {
            setPhase('paused')
            setNote(r.paused)
            router.refresh()
            return
          }
        }
      } catch (e) {
        setError((e as Error).message)
        setPhase('paused')
      }
    },
    [router],
  )

  useEffect(() => {
    // Arriving on /verify?run=ID for a run that was mid-way: pick it back up.
    if (initialRun && (initialRun.status === 'approved' || initialRun.status === 'running') && !initialRun.summary?.paused) {
      void runSteps(initialRun.id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function preview() {
    setError(null)
    setPhase('previewing')
    try {
      const body = ids.length ? { contact_ids: ids, limit: Math.max(limit, ids.length), force } : { filter, limit, force }
      const r = await post<{ run: RunRow }>('/api/verify/preview', body)
      setRun(r.run)
      setCeiling(suggestCeiling(r.run.est_cost_usd))
      setPhase('preview')
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  async function approve() {
    if (!run) return
    const max = parseCeiling(ceiling)
    if (max == null) {
      setError('Enter a dollar ceiling (0 or more).')
      return
    }
    setError(null)
    setPhase('approving')
    try {
      const r = await post<{ run: RunRow }>(`/api/verify/runs/${run.id}/approve`, { max_cost_usd: max })
      setRun(r.run)
      await runSteps(run.id)
    } catch (e) {
      setError((e as Error).message)
      setPhase(run.status === 'preview' ? 'preview' : 'paused')
    }
  }

  async function cancel() {
    if (!run) return
    stopRef.current = true
    try {
      const r = await post<{ run: RunRow }>(`/api/verify/runs/${run.id}/cancel`, {})
      setRun(r.run)
      setPhase('finished')
      router.refresh()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  function reset() {
    setRun(null)
    setPhase('idle')
    setNote(null)
    setError(null)
    setCeiling('')
  }

  const est = run?.summary?.estimate
  const pre = run?.summary?.precheck
  const skipped = run?.summary?.selection?.skipped
  const busy = phase === 'previewing' || phase === 'approving' || phase === 'running'

  return (
    <section aria-labelledby="check-leads" className="space-y-3">
      <SectionHeader id="check-leads" title="Check leads" meta="Free check first. Nothing paid runs until you approve a ceiling." />

      {phase === 'idle' || phase === 'previewing' ? (
        <Card className="p-4">
          {ids.length > 0 ? (
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] text-ink">
              <span>
                <span className="tabular-nums font-medium">{count(ids.length)}</span> leads selected on the Leads screen
              </span>
              <button type="button" className="text-[12px] text-accent hover:underline" onClick={() => setIds([])}>
                Use a filter instead
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
              {FIELDS.map((f) => (
                <label key={f.key} className="block text-[12px] text-ink-muted">
                  {f.label}
                  {f.options ? (
                    <select
                      className="mt-1 block w-full rounded-card border border-line bg-surface px-2 py-1.5 text-[13px] text-ink"
                      value={filter[f.key] ?? ''}
                      onChange={(e) => setFilter({ ...filter, [f.key]: e.target.value || undefined })}
                    >
                      {f.options.map((o) => (
                        <option key={o} value={o}>
                          {o === '' ? 'Any' : o.replace(/_/g, ' ')}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      className="mt-1 block w-full rounded-card border border-line bg-surface px-2 py-1.5 text-[13px] text-ink placeholder:text-ink-faint"
                      placeholder={f.placeholder}
                      value={filter[f.key] ?? ''}
                      onChange={(e) => setFilter({ ...filter, [f.key]: e.target.value || undefined })}
                    />
                  )}
                </label>
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-end gap-4">
            {ids.length === 0 ? (
              <label className="block text-[12px] text-ink-muted">
                At most
                <input
                  type="number"
                  min={1}
                  max={1000}
                  className="mt-1 block w-24 rounded-card border border-line bg-surface px-2 py-1.5 text-[13px] tabular-nums text-ink"
                  value={limit}
                  onChange={(e) => setLimit(Math.min(1000, Math.max(1, Number(e.target.value) || 1)))}
                />
              </label>
            ) : null}
            <label className="flex items-center gap-2 pb-1.5 text-[12px] text-ink-muted">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              Re-check leads verified in the last 30 days
            </label>
            <button
              type="button"
              onClick={preview}
              disabled={busy}
              className="ml-auto rounded-card border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
            >
              {phase === 'previewing' ? 'Running free check…' : 'Run free check'}
            </button>
          </div>
        </Card>
      ) : null}

      {run && phase !== 'idle' && phase !== 'previewing' ? (
        <Card className="p-4" >
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-[14px] font-semibold text-ink">Run #{run.id}</h3>
            <RunStatusPill status={run.status} paused={phase === 'paused'} />
          </div>

          {est && pre ? (
            <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-1.5 text-[13px] sm:grid-cols-2" data-testid="cost-preview">
              <Row label="Checked free" value={count(pre.checked)} />
              <Row label="Failed the free check" value={count(pre.invalid)} hint="bad syntax, no mail server, disposable" />
              <Row label="Go to MillionVerifier" value={`${count(est.mv_checks)} ≈ ${money(est.mv_cost_usd)}`} />
              <Row
                label="Expected to go on to ZeroBounce"
                value={`~${count(est.zb_checks)} ≈ ${money(est.zb_cost_usd)}`}
                hint={
                  est.zb_direct
                    ? `${count(est.zb_direct)} already catch-all/unknown at MillionVerifier + ~${Math.round(est.zb_share * 1000) / 10}% of the rest`
                    : `catch-all / unknown, estimated at ${Math.round(est.zb_share * 1000) / 10}%`
                }
              />
              <Row label="Estimated total" value={money(est.total_usd)} strong />
              {skipped && skipped.no_email + skipped.do_not_contact + skipped.recently_verified > 0 ? (
                <Row
                  label="Left out"
                  value={count(skipped.no_email + skipped.do_not_contact + skipped.recently_verified)}
                  hint={[
                    skipped.recently_verified ? `${skipped.recently_verified} verified in the last 30 days` : null,
                    skipped.no_email ? `${skipped.no_email} no email` : null,
                    skipped.do_not_contact ? `${skipped.do_not_contact} do-not-contact` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                />
              ) : null}
            </dl>
          ) : null}
          {est ? <p className="mt-2 text-[11px] leading-snug text-ink-faint">{est.math}. List prices, not your bill.</p> : null}
          {run.summary?.warnings?.map((w) => (
            <p key={w} className="mt-2 text-[12px] text-warn">
              {w}
            </p>
          ))}

          {run.status !== 'preview' ? (
            <div className="mt-4">
              <div className="flex justify-between text-[12px] tabular-nums text-ink-muted">
                <span>
                  {count(run.processed)} of {count(run.contact_count)} done
                </span>
                <span>
                  {money(run.spent_usd)} spent of {money(run.max_cost_usd)} max
                </span>
              </div>
              <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-line-soft" role="progressbar" aria-valuenow={run.processed} aria-valuemax={run.contact_count}>
                <div className="h-full bg-accent" style={{ width: `${run.contact_count ? (100 * run.processed) / run.contact_count : 100}%` }} />
              </div>
              {run.summary?.verdicts ? <VerdictLine verdicts={run.summary.verdicts} /> : null}
            </div>
          ) : null}

          {note ? <p className="mt-3 text-[12px] text-warn">{note}</p> : null}

          <div className="mt-4 flex flex-wrap items-end gap-3">
            {phase === 'preview' || phase === 'paused' || phase === 'approving' ? (
              <>
                <label className="block text-[12px] text-ink-muted" title="Estimate + 20% headroom by default. The run pauses before it could go past this.">
                  Spend at most ($)
                  <input
                    inputMode="decimal"
                    className="mt-1 block w-28 rounded-card border border-line bg-surface px-2 py-1.5 text-[13px] tabular-nums text-ink"
                    value={ceiling}
                    onChange={(e) => setCeiling(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={approve}
                  disabled={busy || run.contact_count === 0 || parseCeiling(ceiling) == null}
                  className="rounded-card border border-accent bg-accent px-3 py-1.5 text-[13px] font-medium text-white disabled:opacity-60"
                >
                  {phase === 'paused'
                    ? `Continue (max ${money(parseCeiling(ceiling))})`
                    : `Approve and run (max ${money(parseCeiling(ceiling))})`}
                </button>
              </>
            ) : null}
            {phase === 'running' ? <span className="text-[12px] text-ink-muted">Checking… keep this page open.</span> : null}
            {phase !== 'finished' ? (
              <button type="button" onClick={cancel} className="rounded-card border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-muted hover:text-ink">
                Cancel run
              </button>
            ) : (
              <button type="button" onClick={reset} className="rounded-card border border-line bg-surface px-3 py-1.5 text-[13px] text-ink-muted hover:text-ink">
                Check more leads
              </button>
            )}
          </div>
          {!keys.millionverifier && phase === 'preview' ? (
            <p className="mt-2 text-[11px] text-ink-faint">With no MillionVerifier key, approving applies the free-check results only ($0).</p>
          ) : null}
        </Card>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12px] text-bad">
          {error}
        </p>
      ) : null}
    </section>
  )
}

function phaseOf(run: RunRow | null): Phase {
  if (!run) return 'idle'
  if (run.status === 'preview') return 'preview'
  if (run.status === 'approved' || run.status === 'running') return run.summary?.paused ? 'paused' : 'running'
  return 'finished'
}

function Row({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line-soft py-1">
      <dt className="text-ink-muted">
        {label}
        {hint ? <span className="block text-[11px] text-ink-faint">{hint}</span> : null}
      </dt>
      <dd className={`tabular-nums ${strong ? 'font-semibold text-ink' : 'text-ink'}`}>{value}</dd>
    </div>
  )
}

function VerdictLine({ verdicts }: { verdicts: Record<string, number> }) {
  const order = ['valid', 'invalid', 'catch_all', 'unknown', 'risky']
  const parts = order.filter((k) => verdicts[k]).map((k) => `${verdicts[k].toLocaleString('en-US')} ${k.replace('_', '-')}`)
  if (!parts.length) return null
  return <p className="mt-2 text-[12px] tabular-nums text-ink-muted">{parts.join(' · ')}</p>
}

export function RunStatusPill({ status, paused }: { status: string; paused?: boolean }) {
  if (paused && (status === 'running' || status === 'approved')) return <Pill tone="warn">paused</Pill>
  const tone = status === 'done' ? 'good' : status === 'failed' ? 'bad' : status === 'running' || status === 'approved' ? 'accent' : 'neutral'
  return <Pill tone={tone}>{status === 'preview' ? 'waiting for approval' : status}</Pill>
}
