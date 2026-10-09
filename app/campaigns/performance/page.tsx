import { emptyFromSummary, loadStages, loadSummary } from '@/lib/dashboard/load'
import { Dashboard } from '@/components/dashboard/Dashboard'
import { PerformanceView } from '@/components/dashboard/PerformanceView'
import { loadSampleData } from '@/components/dashboard/sample'
import { parseRange } from '@/components/dashboard/range'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { CACHE_SECONDS } from '@/lib/instantly/client'

export const dynamic = 'force-dynamic'

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const range = parseRange(params.range)

  const sample = await loadSampleData()
  if (sample) {
    return <Dashboard data={{ ...sample, range: { ...sample.range, key: range } }} sample />
  }

  // Phase 1 only: totals, deltas and the campaign list. The rest streams in.
  const summary = await loadSummary(range)
  if (!summary.ctx) return <Dashboard data={emptyFromSummary(summary)} />

  return (
    <>
      <PerformanceView summary={summary} stages={loadStages(summary.ctx)} />
      <AutoRefresh on="reply" poll="always" seconds={CACHE_SECONDS} />
    </>
  )
}
