import { getDb } from '@/lib/db'
import { listRuns, getRun, runVerdictCount, type RunRow } from '@/lib/verify/runs'
import { providerBalances, verificationCounts, VERIFICATION_STATUSES } from '@/lib/verify/overview'
import { getPricing } from '@/lib/verify/pricing'
import type { LeadFilter } from '@/lib/verify/select'
import type { ProviderBalance } from '@/lib/verify/types'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { VerifyFlow, RunStatusPill } from '@/components/verify/VerifyFlow'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined

const money = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? '—' : `$${n === 0 || Math.abs(n) >= 0.01 ? n.toFixed(2) : n.toFixed(4)}`

const fmtCount = (n: number | null) => (n == null ? '—' : n.toLocaleString('en-US'))

const STATUS_LABEL: Record<string, string> = {
  unverified: 'Not checked',
  valid: 'Valid',
  invalid: 'Invalid',
  catch_all: 'Catch-all',
  unknown: 'Unknown',
  risky: 'Risky',
}

export default async function VerifyPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  const pricing = getPricing()

  const ids = (one(sp.ids) ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
    .slice(0, 1000)
  const filter: LeadFilter = {}
  for (const k of ['state', 'stage', 'verification_status', 'segment', 'q'] as const) {
    const v = one(sp[k])
    if (v) filter[k] = v
  }

  const providersP = providerBalances()
  let counts: Awaited<ReturnType<typeof verificationCounts>> | null = null
  let runs: RunRow[] = []
  let resume: RunRow | null = null
  let dbError = false
  if (db) {
    try {
      const runId = Number(one(sp.run))
      ;[counts, runs, resume] = await Promise.all([
        verificationCounts(db),
        listRuns(db, 10),
        Number.isInteger(runId) && runId > 0 ? getRun(db, runId) : Promise.resolve(null),
      ])
    } catch {
      dbError = true
    }
  }
  const providers = await providersP

  return (
    <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-[15px] font-semibold tracking-[-0.01em] text-ink">Verification</h1>
        <p className="mt-0.5 text-[12px] leading-snug text-ink-faint">
          Free check (syntax, mail server, disposable) → MillionVerifier → ZeroBounce only for MillionVerifier’s catch-all and
          unknown answers.
        </p>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <ProviderCard name="MillionVerifier" env="MILLIONVERIFIER_API_KEY" b={providers.millionverifier} perCheck={pricing.mvCostPerCheck} />
        <ProviderCard name="ZeroBounce" env="ZEROBOUNCE_API_KEY" b={providers.zerobounce} perCheck={pricing.zbCostPerCheck} note="unknown results are free" />
      </div>

      {!db ? (
        <Card className="mt-6">
          <EmptyNote>The lead database isn’t connected yet (DATABASE_URL is not set), so there are no leads to check.</EmptyNote>
        </Card>
      ) : dbError ? (
        <Card className="mt-6">
          <EmptyNote>Couldn’t read the lead database just now. Nothing was changed.</EmptyNote>
        </Card>
      ) : (
        <>
          <section aria-labelledby="email-status" className="mt-6">
            <SectionHeader id="email-status" title="Emails by status" meta={counts ? `${counts.total.toLocaleString('en-US')} contacts with an email` : null} />
            <Card className="grid grid-cols-3 divide-x divide-y divide-line-soft sm:grid-cols-6 sm:divide-y-0">
              {VERIFICATION_STATUSES.map((s) => (
                <div key={s} className="px-3 py-3">
                  <div className="text-[11px] text-ink-faint">{STATUS_LABEL[s]}</div>
                  <div className="mt-0.5 text-metric-sm tabular-nums text-ink">{counts ? counts.by_status[s].toLocaleString('en-US') : '—'}</div>
                </div>
              ))}
            </Card>
          </section>

          <div className="mt-6">
            <VerifyFlow
              initialIds={ids}
              initialFilter={filter}
              initialRun={resume}
              keys={{ millionverifier: providers.millionverifier.key_set, zerobounce: providers.zerobounce.key_set }}
            />
          </div>

          <section aria-labelledby="recent-runs" className="mt-6">
            <SectionHeader id="recent-runs" title="Recent runs" meta="Spend is from list prices, not the vendors’ bills" />
            <Card className="overflow-x-auto">
              {runs.length === 0 ? (
                <EmptyNote>No verification runs yet.</EmptyNote>
              ) : (
                <table className="w-full min-w-[560px] text-[13px]">
                  <thead>
                    <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-faint">
                      <th className="px-3 py-2 font-medium">Run</th>
                      <th className="px-3 py-2 font-medium">Status</th>
                      <th className="px-3 py-2 text-right font-medium">Leads</th>
                      <th className="px-3 py-2 text-right font-medium">Done</th>
                      <th className="px-3 py-2 text-right font-medium">Valid</th>
                      <th className="px-3 py-2 text-right font-medium">Estimate</th>
                      <th className="px-3 py-2 text-right font-medium">Spent</th>
                      <th className="px-3 py-2 text-right font-medium">Started</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runs.map((r) => (
                      <tr key={r.id} className="border-b border-line-soft last:border-0">
                        <td className="px-3 py-2 tabular-nums">
                          <a className="text-accent hover:underline" href={`/verify?run=${r.id}`}>
                            #{r.id}
                          </a>
                        </td>
                        <td className="px-3 py-2">
                          <RunStatusPill status={r.status} paused={Boolean(r.summary?.paused)} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.contact_count.toLocaleString('en-US')}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.processed.toLocaleString('en-US')}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {fmtCount(runVerdictCount(r, 'valid'))}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{money(r.est_cost_usd)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{r.status === 'preview' ? '—' : money(r.spent_usd)}</td>
                        <td className="px-3 py-2 text-right tabular-nums text-ink-muted">
                          {new Date(r.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: process.env.DASHBOARD_TZ || 'America/New_York' })}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
          </section>
        </>
      )}
    </main>
  )
}

function ProviderCard({ name, env, b, perCheck, note }: { name: string; env: string; b: ProviderBalance; perCheck: number; note?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-[13px] font-semibold text-ink">{name}</h2>
        {b.key_set ? (b.error ? <Pill tone="bad">key problem</Pill> : <Pill tone="good">key set</Pill>) : <Pill tone="neutral">key not set</Pill>}
      </div>
      <p className="mt-2 text-[13px] tabular-nums text-ink">
        {b.key_set ? (
          b.credits != null ? (
            <>
              {b.credits.toLocaleString('en-US')} <span className="text-ink-muted">credits left</span>
            </>
          ) : (
            <span className="text-ink-muted">Balance unavailable{b.error ? `: ${b.error}` : ''}</span>
          )
        ) : (
          <span className="text-ink-muted">Add {env} in Vercel to enable this tier.</span>
        )}
      </p>
      <p className="mt-1 text-[11px] text-ink-faint">
        ≈${perCheck} per check{note ? ` · ${note}` : ''}
      </p>
    </Card>
  )
}
