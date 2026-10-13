import Link from 'next/link'
import { PageShell, BUTTON } from '@/components/app/PageShell'
import { Card, SectionHeader, EmptyNote } from '@/components/dashboard/primitives'
import { ActionNote } from '@/components/reports/Note'
import { Count, Pct, SampleBanner, SourceErrors, TD, TDN, TH, fmtUsd } from '@/components/reports/bits'
import { inputCls } from '@/components/ops/bits'
import { addCostAction, deleteCostAction, saveCampaignMetaAction } from '@/app/actions/reports'
import { loadReportInputs } from '@/lib/reports/load'
import { buildCostReport, CATEGORY_LABEL, COST_CATEGORIES, listCosts, verificationSpend, type CostLine, type CostRow } from '@/lib/reports/costs'
import { SEGMENT_LABEL, angleHintFromName, segmentHintFromName } from '@/lib/reports/meta'
import { listPools } from '@/lib/pools/store'
import type { RangeKey } from '@/lib/dashboard/types'

export const dynamic = 'force-dynamic'

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: '90d', label: '90 days' },
]

function money(v: number | null, zeroWord = 'no data') {
  if (v === null) return <span className="text-unavailable">{zeroWord}</span>
  return <>{fmtUsd(v)}</>
}

function per(cost: number | null, count: number | null, what: string) {
  if (cost === null || count === null) return <span className="text-unavailable">no data</span>
  if (count === 0) return <span className="text-ink-faint">no {what} yet</span>
  return <>{fmtUsd(cost / count)}</>
}

function LineRow({ l, sub }: { l: CostLine; sub?: string }) {
  return (
    <tr className="border-b border-line-soft last:border-0">
      <td className={TD}>
        <div className="font-medium">{l.label}</div>
        {sub || l.partial || l.includesShared ? (
          <div className="text-2xs text-ink-faint">
            {[sub, l.partial ? 'some campaigns did not report every count' : null, l.includesShared ? 'includes a share of shared costs' : null].filter(Boolean).join(' · ')}
          </div>
        ) : null}
      </td>
      <td className={TDN}><Count v={l.contacted} /></td>
      <td className={TDN}><Count v={l.replied} /></td>
      <td className={TDN}><Pct v={l.replyRate} /></td>
      <td className={TDN}><Count v={l.interested} /></td>
      <td className={TDN}><Count v={l.meetings} /></td>
      <td className={TDN}>{money(l.cost)}</td>
      <td className={TDN}>{per(l.cost, l.replied, 'replies')}</td>
      <td className={TDN}>{per(l.cost, l.meetings, 'meetings')}</td>
    </tr>
  )
}

function Head({ first }: { first: string }) {
  return (
    <thead className="border-b border-line">
      <tr>
        <th className={TH}>{first}</th>
        <th className={`${TH} text-right`}>Contacted</th>
        <th className={`${TH} text-right`}>Replies</th>
        <th className={`${TH} text-right`}>Reply rate</th>
        <th className={`${TH} text-right`}>Interested</th>
        <th className={`${TH} text-right`}>Meetings</th>
        <th className={`${TH} text-right`}>Cost</th>
        <th className={`${TH} text-right`}>Per reply</th>
        <th className={`${TH} text-right`}>Per meeting</th>
      </tr>
    </thead>
  )
}

export default async function CostsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const rk = (RANGES.find((r) => r.key === sp.range)?.key ?? '30d') as RangeKey
  const inp = await loadReportInputs(rk, { pools: false })
  const span = { start: inp.data.range.start ?? inp.data.range.end, end: inp.data.range.end }
  let costs: CostRow[] = []
  let allCosts: CostRow[] = []
  let verifySpent: number | null = null
  const errors: string[] = [
    ...(!inp.data.configured ? ['Instantly is not connected (INSTANTLY_API_KEY), so replies and meetings show "no data".'] : []),
    ...(!inp.db ? ['The lead database is not connected (DATABASE_URL), so the cost table can’t be read or edited.'] : []),
    ...(inp.dbError ? [inp.dbError] : []),
    ...inp.data.errors.map((e) => `${e.source}: ${e.message}`),
  ]
  if (inp.db && !inp.dbError) {
    try {
      ;[costs, allCosts, verifySpent] = await Promise.all([listCosts(inp.db, span), listCosts(inp.db), verificationSpend(inp.db, span)])
    } catch (e) {
      errors.push(`Couldn't read costs (${(e as Error).message}).`)
    }
  }
  const report = buildCostReport(inp.data.campaigns, costs, inp.meta, span)
  const thisMonth = inp.data.range.end.slice(0, 7)
  const ret = `/reports/costs?range=${rk}`
  const pools = inp.db ? await listPools(inp.db) : []

  return (
    <PageShell
      title="Cost per meeting"
      meta={`${span.start} to ${span.end}. Replies, interested and meetings from Instantly; costs from your monthly table, prorated by day.`}
      actions={
        <>
          {RANGES.map((r) => (
            <Link key={r.key} href={`/reports/costs?range=${r.key}`} prefetch={false} className={`${BUTTON} ${r.key === rk ? 'border-accent text-accent' : ''}`} aria-current={r.key === rk ? 'page' : undefined}>
              {r.label}
            </Link>
          ))}
          <Link href="/reports" className={BUTTON} prefetch={false}>All reports</Link>
        </>
      }
    >
      {inp.sample ? <SampleBanner /> : null}
      <ActionNote note={sp.note} tone={sp.tone} />
      <SourceErrors errors={errors} />

      <section className="mb-8" aria-labelledby="angle-h">
        <SectionHeader id="angle-h" title="By angle" meta={report.totalCost === null ? 'No costs entered for this period yet' : `Total cost in period ${fmtUsd(report.totalCost)}`} />
        <Card className="overflow-x-auto">
          {report.angles.length === 0 ? (
            <EmptyNote>No campaigns to show.</EmptyNote>
          ) : (
            <table className="w-full min-w-[820px] border-collapse">
              <Head first="Angle" />
              <tbody>
                {report.angles.map((l) => (
                  <LineRow key={l.key} l={l} sub={`${l.campaignIds.length} campaign${l.campaignIds.length === 1 ? '' : 's'}`} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
        <p className="mt-2 text-xs text-ink-faint">
          Shared costs (no campaign picked) are split across campaigns by emails sent in the period.
          {report.unallocatedShared > 0 ? ` ${fmtUsd(report.unallocatedShared)} of shared cost isn’t split because nothing was sent.` : ''}
          {report.directCostUnknownCampaign > 0 ? ` ${fmtUsd(report.directCostUnknownCampaign)} is tied to campaigns not in this list.` : ''}
        </p>
      </section>

      <section className="mb-8" aria-labelledby="camp-h">
        <SectionHeader id="camp-h" title="By campaign" />
        <Card className="overflow-x-auto">
          {report.campaigns.length === 0 ? (
            <EmptyNote>No campaigns to show.</EmptyNote>
          ) : (
            <table className="w-full min-w-[820px] border-collapse">
              <Head first="Campaign" />
              <tbody>
                {report.campaigns.map((l) => (
                  <LineRow key={l.key} l={l} sub={inp.meta.get(l.key)?.angle ?? 'angle not set'} />
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>

      <section className="mb-8" aria-labelledby="costs-h">
        <SectionHeader id="costs-h" title="Monthly costs" meta="What you pay each month. Edit any time; every number above updates." />
        <Card className="overflow-x-auto">
          {allCosts.length === 0 ? (
            <EmptyNote>No costs entered yet. Add inboxes, tools and verification below.</EmptyNote>
          ) : (
            <table className="w-full min-w-[640px] border-collapse">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>Month</th>
                  <th className={TH}>What</th>
                  <th className={TH}>Campaign</th>
                  <th className={`${TH} text-right`}>Per month</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {allCosts.map((c) => (
                  <tr key={c.id} className="border-b border-line-soft last:border-0">
                    <td className={TD}>{c.month.slice(0, 7)}</td>
                    <td className={TD}>
                      <div>{c.label}</div>
                      <div className="text-2xs text-ink-faint">{CATEGORY_LABEL[c.category]}{c.notes ? ` · ${c.notes}` : ''}</div>
                    </td>
                    <td className={TD}>{c.campaign_id ? (inp.data.campaigns.find((x) => x.id === c.campaign_id)?.name ?? c.campaign_id) : <span className="text-ink-faint">Shared</span>}</td>
                    <td className={TDN}>{fmtUsd(c.amount_usd)}</td>
                    <td className={`${TD} text-right`}>
                      <form action={deleteCostAction}>
                        <input type="hidden" name="id" value={c.id} />
                        <input type="hidden" name="return_to" value={ret} />
                        <button className="text-xs text-ink-faint hover:text-bad" type="submit">Remove</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
        {inp.db ? (
          <form action={addCostAction} className="mt-3 grid gap-2 rounded-card border border-line bg-surface p-3 sm:grid-cols-[110px_130px_1fr_1fr_110px_auto]" aria-label="Add a cost">
            <input type="hidden" name="return_to" value={ret} />
            <input name="month" defaultValue={thisMonth} className={inputCls} aria-label="Month (YYYY-MM)" placeholder="2026-10" />
            <select name="category" className={inputCls} aria-label="Category" defaultValue="inboxes">
              {COST_CATEGORIES.map((c) => (
                <option key={c} value={c}>{CATEGORY_LABEL[c]}</option>
              ))}
            </select>
            <input name="label" className={inputCls} aria-label="What" placeholder="e.g. 27 sending inboxes" required />
            <select name="campaign_id" className={inputCls} aria-label="Campaign" defaultValue="">
              <option value="">Shared (all campaigns)</option>
              {inp.data.campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <input name="amount_usd" inputMode="decimal" className={inputCls} aria-label="Dollars per month" placeholder="$ / month" required />
            <button type="submit" className={BUTTON}>Save cost</button>
          </form>
        ) : null}
        {verifySpent !== null ? (
          <p className="mt-2 text-xs text-ink-faint">
            Paid verification recorded by verification runs in this period: {fmtUsd(verifySpent)}. It isn’t added automatically; add it as a Verification cost if you want it counted.
          </p>
        ) : null}
      </section>

      <section aria-labelledby="campaign-setup">
        <SectionHeader id="campaign-setup" title="Campaign angle and segment" meta="Groups the numbers above and the runway by segment" />
        <Card className="divide-y divide-line-soft">
          {inp.data.campaigns.length === 0 ? (
            <EmptyNote>No campaigns from Instantly.</EmptyNote>
          ) : (
            inp.data.campaigns.map((c) => {
              const m = inp.meta.get(c.id)
              return (
                <form key={c.id} action={saveCampaignMetaAction} className="grid items-center gap-2 px-3 py-2 sm:grid-cols-[1fr_150px_220px_auto]">
                  <input type="hidden" name="campaign_id" value={c.id} />
                  <input type="hidden" name="campaign_name" value={c.name} />
                  <input type="hidden" name="return_to" value={`${ret}#campaign-setup`} />
                  <div className="min-w-0 text-sm">
                    <div className="truncate font-medium text-ink">{c.name}</div>
                    <div className="text-2xs text-ink-faint">{c.status}{m ? '' : ' · not set yet'}</div>
                  </div>
                  <select name="segment" defaultValue={m?.segment ?? ''} className={inputCls} aria-label={`Segment for ${c.name}`}>
                    <option value="">Segment…{!m && segmentHintFromName(c.name) ? ` (${SEGMENT_LABEL[segmentHintFromName(c.name)!]}?)` : ''}</option>
                    {pools.map((s) => (
                      <option key={s.id} value={s.id}>{s.label}</option>
                    ))}
                  </select>
                  <input name="angle" defaultValue={m?.angle ?? ''} placeholder={angleHintFromName(c.name) ?? 'Angle, e.g. Held payouts'} className={inputCls} aria-label={`Angle for ${c.name}`} />
                  <button type="submit" className={BUTTON}>Save</button>
                </form>
              )
            })
          )}
        </Card>
      </section>
    </PageShell>
  )
}
