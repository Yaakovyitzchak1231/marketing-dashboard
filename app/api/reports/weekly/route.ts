/**
 * GET /api/reports/weekly?format=json|md — the weekly one-pager for the signed-in
 * human (behind the login gate). Agents use /api/ops/reports/weekly with their token.
 */
import { NextResponse } from 'next/server'
import { loadWeeklyReport } from '@/lib/reports/load'
import { weeklyMarkdown } from '@/lib/reports/weekly'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const format = new URL(req.url).searchParams.get('format') ?? 'json'
  const { report, sample } = await loadWeeklyReport()
  if (format === 'md' || format === 'markdown') {
    return new NextResponse((sample ? '> SAMPLE DATA (local preview)\n\n' : '') + weeklyMarkdown(report), {
      headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Disposition': `inline; filename="weekly-${report.period.end}.md"` },
    })
  }
  return NextResponse.json({ ok: true, sample, report }, { headers: { 'Cache-Control': 'no-store' } })
}
