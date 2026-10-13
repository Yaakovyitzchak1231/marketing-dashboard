import type { DashboardData, DateRange } from '@/lib/dashboard/types'
import { AccountsTable } from './AccountsTable'
import { CampaignTable } from './CampaignTable'
import { DailyChart } from './DailyChart'
import { Header } from './Header'
import { Insights } from './Insights'
import { Kpis, SecondaryStats } from './Kpis'
import { NotConfigured } from './NotConfigured'
import { ErrorsNotice } from './Notices'
import { RepliesList } from './RepliesList'
import { rangeLabel } from './format'
import { Card } from './primitives'
import { openTrackingOff } from '@/lib/dashboard/metrics'

/** The whole dashboard for one DashboardData. Pure render; page.tsx fetches. */
export function Dashboard({ data, sample = false }: { data: DashboardData; sample?: boolean }) {
  return (
    <div className="min-h-screen">
      {sample ? (
        <div className="bg-ink px-4 py-1.5 text-center text-xs font-semibold uppercase tracking-[0.08em] text-canvas" data-testid="sample-banner">
          Sample data · local preview only · not your Instantly numbers
        </div>
      ) : null}
      <Header range={data.range} generatedAt={data.generatedAt} live={data.configured} />
      <main className="mx-auto max-w-shell px-4 pb-16 pt-5 sm:px-6 sm:pt-6">
        {!data.configured ? (
          <div className="pt-6 sm:pt-12">
            <NotConfigured />
          </div>
        ) : (
          <Body data={data} />
        )}
      </main>
    </div>
  )
}

function Body({ data }: { data: DashboardData }) {
  const nothing =
    data.campaigns.length === 0 && data.daily.length === 0 && data.accounts.length === 0 && data.repliedLeads.length === 0
  return (
    <div className="flex flex-col gap-7 sm:gap-8">
      {data.errors.length ? <ErrorsNotice errors={data.errors} /> : null}
      {nothing && data.errors.length === 0 ? (
        <Card className="px-5 py-10 text-center" >
          <p className="text-base font-medium text-ink" data-testid="empty-range">No campaign activity in {rangeLabel(data.range.key).toLowerCase()}.</p>
          <p className="mt-1 text-sm text-ink-muted">Try a longer range, or check that your campaigns are running in Instantly.</p>
        </Card>
      ) : (
        <>
          {/* Numbers first, then what to do about them (the same order the live page streams in). */}
          <div>
            <Kpis counts={data.totals.counts} rates={data.totals.rates} previous={data.previous} />
            <SecondaryStats
              counts={data.totals.counts}
              rates={data.totals.rates}
              trackingOff={openTrackingOff(data.campaigns.map((c) => c.openTracking))}
            />
          </div>
          <Insights insights={data.insights} />
          <DailyChart daily={data.daily} />
          <CampaignTable campaigns={data.campaigns} />
          <div className="grid gap-7 sm:gap-8 lg:grid-cols-2">
            <RepliesList leads={data.repliedLeads} />
            <AccountsTable accounts={data.accounts} />
          </div>
          <Footnote range={data.range} previous={data.previous} />
        </>
      )}
    </div>
  )
}

export function Footnote({ range, previous }: { range: DateRange; previous: DashboardData['previous'] }) {
  return (
    <footer className="border-t border-line pt-4 text-2xs leading-relaxed text-ink-faint">
      Reply rate = leads who replied ÷ leads contacted (auto-replies excluded). Positive rate = leads marked interested in Instantly ÷ leads contacted.
      Bounce rate = bounced ÷ emails sent. Days are counted in {range.timezone}.
      Everything on this page is Instantly&apos;s own count for the dates selected, and the replies list shows only the newest replies. The Overview and Replies pages count the replies and labels this app has stored, so their numbers can differ.
      {previous ? ' Changes compare with the same number of days just before this range.' : ''}
    </footer>
  )
}
