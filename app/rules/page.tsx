import Link from 'next/link'
import { getDb } from '@/lib/db'
import { listProposals, listRuleSets } from '@/lib/rules/store'
import { recomputeStatus, tierCounts } from '@/lib/rules/recompute'
import { STANDING_RULES } from '@/lib/rules/standing'
import { listPools } from '@/lib/pools/store'
import { SEGMENT_LABEL as SEGMENT_WORDS } from '@/lib/reports/meta'
import { kickRecompute } from '@/lib/rules/kick'
import { createRulesAction } from '@/app/actions/rules'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice, SCOPE_WORDS } from '@/components/rules/bits'
import { TD, TDN, TH } from '@/components/reports/bits'

export const dynamic = 'force-dynamic'

const n = (v: number | undefined) => (v === undefined ? '—' : v.toLocaleString('en-US'))

export default async function RulesPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Lead rules" meta="What makes a lead Ready, per pool and per campaign">
        <DbNotConnected what="Lead rules" />
      </PageFrame>
    )
  }
  const [sets, counts, jobs, proposals, pools] = await Promise.all([listRuleSets(db), tierCounts(db), recomputeStatus(db), listProposals(db), listPools(db)])
  if ([...jobs.values()].some((j) => j.status === 'queued' || j.status === 'running')) kickRecompute(db)
  const sources = sets
  return (
    <PageFrame
      title="Lead rules"
      meta="A campaign uses its own rules if it has them, else its pool's, else the default. Saving re-scores every lead in the background."
    >
      <Notice error={sp.error} saved={sp.saved} />
      {proposals.length ? (
        <Card className="mb-6 border-warn/40 p-4">
          <p className="text-sm font-semibold text-ink">Agents proposed {proposals.length} rule change{proposals.length === 1 ? '' : 's'}</p>
          <ul className="mt-1 text-xs text-ink-muted">
            {proposals.map((p) => (
              <li key={p.approval_id}>
                <Link className="text-accent hover:underline" href={`/rules/${p.rule_set_id}`}>
                  #{p.approval_id} from {p.requested_by_name ?? p.requested_by}
                </Link>{' '}
                · {p.changes.length} change{p.changes.length === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      <section className="mb-6">
        <SectionHeader title="Rule sets" meta="Counts are leads scored under each set (stored; re-scored after every change). — means not scored yet." />
        <Card className="overflow-x-auto">
          <table className="w-full min-w-[640px]">
            <thead className="border-b border-line">
              <tr>
                <th className={TH}>Name</th>
                <th className={TH}>Applies to</th>
                <th className={`${TH} text-right`}>Ready-personalized</th>
                <th className={`${TH} text-right`}>Ready-generic</th>
                <th className={`${TH} text-right`}>Parked</th>
                <th className={TH}>Re-scoring</th>
              </tr>
            </thead>
            <tbody>
              {sets.map((r) => {
                const c = counts.get(r.id)
                const j = jobs.get(r.id)
                return (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className={TD}>
                      <Link href={`/rules/${r.id}`} className="font-medium text-ink hover:text-accent">
                        {r.name}
                      </Link>
                      <span className="ml-1 text-xs text-ink-faint">v{r.version}</span>
                    </td>
                    <td className={TD}>
                      {SCOPE_WORDS[r.scope]}
                      {r.scope === 'pool' && r.segment ? `: ${SEGMENT_WORDS[r.segment] ?? r.segment}` : ''}
                      {r.scope === 'campaign' ? `: ${r.campaign_name ?? r.campaign_id ?? 'a dashboard campaign'}` : ''}
                    </td>
                    <td className={TDN}>{r.scope === 'template' ? '—' : n(c?.ready_personalized)}</td>
                    <td className={TDN}>{r.scope === 'template' ? '—' : n(c?.ready_generic)}</td>
                    <td className={TDN}>{r.scope === 'template' ? '—' : n(c?.parked)}</td>
                    <td className={TD}>
                      {r.scope === 'template'
                        ? 'scores no leads'
                        : !j
                          ? 'not queued'
                          : j.status === 'done'
                            ? `done (${n(j.processed)} leads)`
                            : `${j.status}: ${n(j.processed)}${j.total != null ? ` of ${n(j.total)}` : ''}`}
                      {c?.stale ? <span className="text-ink-faint"> · {n(c.stale)} waiting to refresh</span> : null}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {!sets.length ? <EmptyNote>No rule sets yet. Run the database migrations (0010).</EmptyNote> : null}
        </Card>
      </section>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">Give a campaign its own rules</p>
          <p className="mt-0.5 text-xs text-ink-muted">Start from a template or copy any set. Without its own rules a campaign uses its pool&apos;s.</p>
          <form action={createRulesAction} className="mt-3 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="scope" value="campaign" />
            <label className="text-xs text-ink-muted">
              Instantly campaign id
              <input name="campaign_id" required className={inputCls} placeholder="e.g. 3f2a…" />
            </label>
            <label className="text-xs text-ink-muted">
              Campaign name
              <input name="campaign_name" className={inputCls} />
            </label>
            <label className="text-xs text-ink-muted">
              Pool (which leads it scores)
              <select name="segment" className={inputCls} defaultValue="">
                <option value="">as set on the campaign</option>
                {pools.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Start from
              <select name="from_id" required className={inputCls}>
                {sources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <button className={primaryBtnCls}>Create campaign rules</button>
            </div>
          </form>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">New template</p>
          <p className="mt-0.5 text-xs text-ink-muted">A template scores nothing; campaigns start from it.</p>
          <form action={createRulesAction} className="mt-3 grid gap-2 sm:grid-cols-2">
            <input type="hidden" name="scope" value="template" />
            <label className="text-xs text-ink-muted">
              Name
              <input name="name" required className={inputCls} placeholder="Template: …" />
            </label>
            <label className="text-xs text-ink-muted">
              Copy of
              <select name="from_id" required className={inputCls}>
                {sources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <button className={btnCls}>Create template</button>
            </div>
          </form>
        </Card>
      </section>

      <section>
        <SectionHeader title="Standing rules" meta="Always on, for every campaign. Not editable." />
        <Card className="p-4">
          <ul className="list-disc space-y-1 pl-5 text-xs text-ink-muted">
            {STANDING_RULES.map((r) => (
              <li key={r.code}>{r.label}</li>
            ))}
            <li>Only Ready leads (personalized or generic) can be added to Instantly; the list is re-checked at the moment you confirm.</li>
            <li>Verification order stays free checks, then MillionVerifier, then ZeroBounce. Rules decide which verdicts count, not the order.</li>
            <li>Agents can read rules but not change them; their proposals wait in Needs your OK.</li>
          </ul>
        </Card>
      </section>
    </PageFrame>
  )
}
