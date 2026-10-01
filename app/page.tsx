import Link from 'next/link'
import { KpiRow } from '@/components/kpi-row'
import { CampaignTable } from '@/components/campaign-table'
import { TrendChartArea } from '@/components/trend-chart'
import { SenderHealthPanel } from '@/components/sender-health'
import { FreshnessIndicator } from '@/components/freshness'
import { COPY } from '@/lib/copy'
import { buildShellModel } from '@/lib/shell-model'
import { loadShellData } from '@/lib/load-shell-data'
import { RANGE_LABEL } from '@/lib/range'

/**
 * The dashboard shell. A Server Component: every figure below arrives already
 * fetched, so the data path from the database to the screen is a server render
 * rather than a fetch the browser has to make and could get wrong.
 *
 * It is not, however, a page without a client bundle. The campaign table is a
 * client island -- search, filtering and sorting happen on screen, and they
 * cannot happen in a server render -- and that costs two things worth naming
 * instead of glossing: every campaign row is serialized into the RSC payload
 * the browser downloads, and the table's controls ship as client JavaScript.
 * The other panels stay server-only. An earlier version of this comment claimed
 * the shell shipped no client bundle and that interactivity was deliberately
 * absent because it would have cost that claim; the table made the claim false,
 * and a comment asserting an invariant the code no longer holds is the same
 * defect as a figure that no longer matches the row behind it.
 *
 * The first campaign in the list drives the trend chart. That is a real
 * constraint, not a shortcut: the trend endpoint is per-campaign, and a
 * portfolio-wide trend would be a number the API does not provide.
 */
export const dynamic = 'force-dynamic'

export default async function DashboardPage() {
  const campaigns = await loadShellData(null)

  // The trend needs a campaign id, which we only learn from the campaign list,
  // so the two fetches cannot be parallelised here without inventing a
  // portfolio total. The extra round trip is the cost of not fabricating.
  const firstCampaignId = campaigns.campaigns?.campaigns?.[0]?.id ?? null
  const withTrend = firstCampaignId
    ? await loadShellData(firstCampaignId, campaigns.freshness)
    : campaigns

  const model = buildShellModel({
    overview: withTrend.overview,
    campaigns: withTrend.campaigns,
    trend: withTrend.trend,
    freshness: withTrend.freshness,
    trendFailed: withTrend.trendFailed,
  })

  return (
    <main className="mx-auto w-full max-w-shell px-4 py-6 sm:px-6 sm:py-10">
      {/*
        The header is a masthead, not a hero. A product name in large type with
        a gradient behind it is the template look this project is avoiding; a
        quiet title with the freshness line beside it is what an internal tool
        actually needs.
      */}
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-[15px] font-medium tracking-[-0.01em] text-ink">
            Marketing dashboard
          </h1>
          <p className="mt-0.5 text-[11px] text-ink-faint">
            Instantly account &mdash; {RANGE_LABEL}
          </p>
        </div>
        <FreshnessIndicator
          generatedAt={model.freshness.generatedAt}
          stale={model.freshness.collectionFailed}
        />
      </header>

      {model.overviewUnavailable ? (
        // The failure is stated once, at the top, before the reader reaches a
        // figure. The freshness line already says the collection failed, so
        // this band's only job is to explain why the numbers below are blank
        // rather than repeating the same sentence twice on one screen.
        <div
          data-testid="overview-unavailable"
          className="mb-4 border-l-2 border-warn px-3 py-2 text-[12px] text-ink-muted"
        >
          {COPY.error}
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <KpiRow kpis={model.kpis} />

        <SenderHealthPanel health={model.senderHealth} />

        {model.trendError ? (
          // A failed chart says so. It does not render as an empty chart,
          // because "we could not load this" and "there is no history yet" are
          // different facts and the reader is entitled to the difference.
          <div
            data-testid="trend-error"
            className="rounded-card border border-line bg-surface px-5 py-4"
          >
            <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
              Trend
            </p>
            <p className="mt-1 text-[13px] text-ink-faint">{COPY.error}</p>
          </div>
        ) : (
          <TrendChartArea series={model.trend} label="Emails sent" />
        )}

        <CampaignTable rows={model.campaigns} total={model.campaignTotal} />

        <nav
          aria-label="Analysis"
          className="rounded-card border border-line bg-surface px-5 py-4"
        >
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-ink-muted">
            What is working
          </p>
          <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px]">
            <Link href="/ideas" className="text-ink underline-offset-4 hover:underline">
              Ideas — cost per outcome
            </Link>
            <Link href="/funnel" className="text-ink underline-offset-4 hover:underline">
              Funnel
            </Link>
            <Link href="/angles" className="text-ink underline-offset-4 hover:underline">
              Angles
            </Link>
            <Link href="/verification" className="text-ink underline-offset-4 hover:underline">
              Lead verification
            </Link>
            <Link href="/infrastructure" className="text-ink underline-offset-4 hover:underline">
              Infrastructure
            </Link>
            <Link href="/costs" className="text-ink underline-offset-4 hover:underline">
              Costs
            </Link>
          </div>
        </nav>
      </div>
    </main>
  )
}
