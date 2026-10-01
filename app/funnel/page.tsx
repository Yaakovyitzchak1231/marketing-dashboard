import Link from 'next/link'
import { getBaseUrl } from '@/lib/base-url'
import { COPY } from '@/lib/copy'
import { formatCount, formatRate } from '@/lib/format'
import { PERFORMANCE_RANGE, PERFORMANCE_RANGE_LABEL } from '@/lib/range'

export const dynamic = 'force-dynamic'

type FunnelRow = {
  campaign_id?: string
  campaign_name?: string
  idea_id?: string
  idea_name: string
  contacted: number | null
  replied: number | null
  positive: number | null
  meetings: number | null
  customers: number | null
  reply_rate: number | null
  positive_rate: number | null
  meeting_rate: number | null
  close_rate: number | null
}

function FunnelTable({ rows, label }: { rows: FunnelRow[]; label: string }) {
  if (rows.length === 0) {
    return <p className="text-[13px] text-ink-faint">{COPY.funnel.noRows(label)}</p>
  }
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.06em] text-ink-muted">
            <th className="px-4 py-2 font-medium">{label}</th>
            <th className="px-4 py-2 text-right font-medium">Contacted</th>
            <th className="px-4 py-2 text-right font-medium">Replied</th>
            <th className="px-4 py-2 text-right font-medium">Opportunities</th>
            <th className="px-4 py-2 text-right font-medium">Meetings</th>
            <th className="px-4 py-2 text-right font-medium">Customers</th>
            <th className="px-4 py-2 text-right font-medium">Reply %</th>
            <th className="px-4 py-2 text-right font-medium">Opportunity %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-line last:border-0">
              <td className="px-4 py-2 text-ink">{r.campaign_name ?? r.idea_name}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.contacted)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.replied)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.positive)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.meetings)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink-muted">{formatCount(r.customers)}</td>
              {/* Rates are formatted in lib/format.ts; never recomputed with * 100 here. */}
              <td className="px-4 py-2 text-right tabular-nums text-ink">{formatRate(r.reply_rate)}</td>
              <td className="px-4 py-2 text-right tabular-nums text-ink">{formatRate(r.positive_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default async function FunnelPage() {
  // Origin for the server-side self-fetch. The fallback port lives in
  // lib/base-url.ts so this file never carries a numeric literal.
  const base = getBaseUrl()
  const { cookies } = await import('next/headers')
  const cookie = (await cookies()).toString()

  let data: { campaigns: FunnelRow[]; ideas: FunnelRow[] } | null = null
  try {
    // PERFORMANCE_RANGE is the window this view reports over. Inlining `30d`
    // would put a number in the render path that no query produced.
    const res = await fetch(`${base}/api/funnel?range=${PERFORMANCE_RANGE}`, {
      cache: 'no-store',
      headers: cookie ? { cookie } : undefined,
    })
    if (res.ok) data = await res.json()
  } catch {
    data = null
  }

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">{COPY.funnel.title}</h1>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Contacted → human replies → opportunities. Meetings and customers are not reported by the source. {PERFORMANCE_RANGE_LABEL}.
            </p>
        </div>
        <Link href="/" className="text-[12px] text-ink-muted underline-offset-4 hover:underline">
          Back to dashboard
        </Link>
      </header>

      {data === null ? (
        <p className="text-[13px] text-ink-faint">{COPY.funnel.unavailable}</p>
      ) : (
        <div className="space-y-8">
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              {COPY.funnel.byIdea}
            </h2>
            <FunnelTable rows={data.ideas} label="Idea" />
          </section>
          <section>
            <h2 className="mb-3 text-[12px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              {COPY.funnel.byCampaign}
            </h2>
            <FunnelTable rows={data.campaigns} label="Campaign" />
          </section>
        </div>
      )}
    </main>
  )
}
