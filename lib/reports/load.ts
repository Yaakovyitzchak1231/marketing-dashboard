import 'server-only'
/**
 * Server loaders shared by the Reports screens and the agent API. Each piece
 * that is not configured comes back null / configured:false — never invented.
 */
import { getDb } from '@/lib/db'
import type { Db } from '@/lib/db/types'
import { getDashboardData } from '@/lib/dashboard/load'
import type { DashboardData, RangeKey } from '@/lib/dashboard/types'
import { loadSampleData } from '@/components/dashboard/sample'
import { listCampaignMeta, type CampaignMeta } from '@/lib/reports/meta'
import { segmentPools, type SegmentPool } from '@/lib/reports/runway'
import { buildWeeklyReport, openTasks, pendingApprovals, type WeeklyReport } from '@/lib/reports/weekly'

export interface ReportInputs {
  data: DashboardData
  sample: boolean
  db: Db | null
  meta: Map<string, CampaignMeta>
  pools: SegmentPool[] | null
  dbError: string | null
}

/** Calendar days covered by a range (inclusive); the pace divisor. */
export function rangeDays(data: DashboardData): number {
  if (!data.range.start) return 30
  const a = Date.parse(`${data.range.start}T00:00:00Z`)
  const b = Date.parse(`${data.range.end}T00:00:00Z`)
  return Math.max(1, Math.round((b - a) / 86_400_000) + 1)
}

export async function loadReportInputs(range: RangeKey, opts: { pools?: boolean } = {}): Promise<ReportInputs> {
  const sampleData = await loadSampleData()
  const data = sampleData ?? (await getDashboardData(range))
  const db = getDb()
  let meta = new Map<string, CampaignMeta>()
  let pools: SegmentPool[] | null = null
  let dbError: string | null = null
  if (db) {
    try {
      meta = await listCampaignMeta(db)
      if (opts.pools !== false) pools = await segmentPools(db)
    } catch (e) {
      dbError = `Couldn't read the lead database (${String((e as Error).message).slice(0, 160)}). Run npm run db:migrate if this is a new deploy.`
    }
  }
  return { data, sample: Boolean(sampleData), db, meta, pools, dbError }
}

export async function loadWeeklyReport(): Promise<{ report: WeeklyReport; sample: boolean }> {
  const inp = await loadReportInputs('7d')
  let tasks = null
  let approvals = null
  if (inp.db && !inp.dbError) {
    try {
      ;[tasks, approvals] = await Promise.all([openTasks(inp.db), pendingApprovals(inp.db)])
    } catch {
      tasks = null
    }
  }
  const report = buildWeeklyReport({
    data: inp.data,
    meta: inp.meta,
    pools: inp.pools,
    tasks,
    approvals,
    dbConfigured: Boolean(inp.db),
    windowDays: rangeDays(inp.data),
  })
  if (inp.dbError) report.errors.unshift(inp.dbError)
  return { report, sample: inp.sample }
}
