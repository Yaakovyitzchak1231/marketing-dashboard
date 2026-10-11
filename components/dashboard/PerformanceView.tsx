import { Suspense } from 'react'
import type { ReactNode } from 'react'
import type { CampaignRow, DailyPoint, RepliedLead, SenderAccount, SourceError } from '@/lib/dashboard/types'
import type { DashboardSummary, Stage, StageResults, Stages } from '@/lib/dashboard/load'
import { combineStages, insightsFor } from '@/lib/dashboard/load'
import { AccountsTable } from './AccountsTable'
import { CampaignTable } from './CampaignTable'
import { DailyChart } from './DailyChart'
import { Footnote } from './Dashboard'
import { Header } from './Header'
import { Insights } from './Insights'
import { Kpis, SecondaryStats } from './Kpis'
import { ErrorsNotice } from './Notices'
import { RepliesList } from './RepliesList'

/**
 * The campaign performance page, streamed. The numbers that only need the fast
 * first round of calls (totals, deltas, the secondary line) render immediately;
 * every other section waits on its own stage and fills in when that stage
 * answers, with its own placeholder and its own error notice. A slow per-inbox
 * or per-campaign call therefore no longer holds up the whole page.
 *
 * Numbers first, then the "what to do next" callouts (which need every stage).
 */
export function PerformanceView({ summary, stages }: { summary: DashboardSummary; stages: Stages }) {
  return (
    <div className="min-h-screen">
      <Header range={summary.range} generatedAt={summary.generatedAt} live />
      <main className="mx-auto max-w-shell px-4 pb-16 pt-5 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-7 sm:gap-8">
          {/* Phase-1 failures affect the totals, so they sit with them. */}
          {summary.errors.length ? <ErrorsNotice errors={summary.errors} /> : null}
          <KpiSection summary={summary} />
          <Suspense fallback={<InsightsSkeleton />}>
            <InsightsStage summary={summary} stages={stages} />
          </Suspense>
          <Suspense fallback={<ChartSkeleton />}>
            <AwaitStage stage={stages.daily}>{(r) => <DailySection result={r} />}</AwaitStage>
          </Suspense>
          <Suspense fallback={<TableSkeleton />}>
            <AwaitStage stage={stages.campaigns}>{(r) => <CampaignsSection result={r} />}</AwaitStage>
          </Suspense>
          <div className="grid gap-7 sm:gap-8 lg:grid-cols-2">
            <Suspense fallback={<CardSkeleton />}>
              <AwaitStage stage={stages.replies}>{(r) => <RepliesSection result={r} />}</AwaitStage>
            </Suspense>
            <Suspense fallback={<CardSkeleton />}>
              <AwaitStage stage={stages.accounts}>{(r) => <AccountsSection result={r} />}</AwaitStage>
            </Suspense>
          </div>
          <Footnote range={summary.range} previous={summary.previous} />
        </div>
      </main>
    </div>
  )
}

/** Awaits one stage, then hands the resolved result to a plain component. */
async function AwaitStage<T>({ stage, children }: { stage: Promise<T>; children: (result: T) => ReactNode }) {
  return <>{children(await stage)}</>
}

/** Totals, deltas and the secondary line: everything phase 1 returned. */
export function KpiSection({ summary }: { summary: DashboardSummary }) {
  return (
    <div>
      <Kpis counts={summary.totals.counts} rates={summary.totals.rates} previous={summary.previous} />
      <SecondaryStats counts={summary.totals.counts} rates={summary.totals.rates} trackingOff={summary.trackingOff} />
    </div>
  )
}

function Section({ errors, children }: { errors: SourceError[]; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      {errors.length ? <ErrorsNotice errors={errors} /> : null}
      {children}
    </div>
  )
}

export function DailySection({ result }: { result: Stage<DailyPoint[]> }) {
  return (
    <Section errors={result.errors}>
      <DailyChart daily={result.data} />
    </Section>
  )
}

export function CampaignsSection({ result }: { result: Stage<CampaignRow[]> }) {
  return (
    <Section errors={result.errors}>
      <CampaignTable campaigns={result.data} />
    </Section>
  )
}

export function RepliesSection({ result }: { result: Stage<RepliedLead[]> }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {result.errors.length ? <ErrorsNotice errors={result.errors} /> : null}
      <RepliesList leads={result.data} />
    </div>
  )
}

export function AccountsSection({ result }: { result: Stage<SenderAccount[]> }) {
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {result.errors.length ? <ErrorsNotice errors={result.errors} /> : null}
      <AccountsTable accounts={result.data} />
    </div>
  )
}

/** The callouts need every stage, so this section resolves last. */
export function InsightsSection({ summary, results }: { summary: DashboardSummary; results: StageResults }) {
  const insights = insightsFor(combineStages(summary, results))
  return (
    <Section errors={insights.errors}>
      <Insights insights={insights.data} />
    </Section>
  )
}

async function InsightsStage({ summary, stages }: { summary: DashboardSummary; stages: Stages }) {
  const [daily, campaigns, accounts, replies] = await Promise.all([stages.daily, stages.campaigns, stages.accounts, stages.replies])
  return <InsightsSection summary={summary} results={{ daily, campaigns, accounts, replies }} />
}

// ---- Placeholders: the same shape as the section they stand in for ----------------

function Block({ className }: { className: string }) {
  return <div className={`animate-pulse rounded-card bg-line-soft ${className}`} />
}

function SectionLabel() {
  return <Block className="h-3 w-32" />
}

function InsightsSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Working out what to do next">
      <SectionLabel />
      <div className="space-y-3 rounded-card border border-line bg-surface p-4 shadow-card">
        <Block className="h-3 w-24" />
        <Block className="h-4 w-3/5" />
        <Block className="h-3 w-full" />
        <Block className="h-3 w-4/5" />
      </div>
    </div>
  )
}

function ChartSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading the daily chart">
      <SectionLabel />
      <Block className="h-[220px] w-full" />
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading campaign results">
      <SectionLabel />
      <Block className="h-[260px] w-full" />
    </div>
  )
}

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3" aria-busy="true" aria-label="Loading">
      <SectionLabel />
      <Block className="h-[200px] w-full" />
    </div>
  )
}
