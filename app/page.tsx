import { getDashboardData } from '@/lib/dashboard/load'
import { Dashboard } from '@/components/dashboard/Dashboard'
import { loadSampleData } from '@/components/dashboard/sample'
import { parseRange } from '@/components/dashboard/range'

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

  const data = await getDashboardData(range)
  return <Dashboard data={data} />
}
