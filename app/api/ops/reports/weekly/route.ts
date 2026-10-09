/**
 * GET /api/ops/reports/weekly?format=json|md — the weekly one-pager for an agent
 * (Authorization: Bearer <its OPS_AGENT_TOKENS token>). Read-only.
 */
import { NextResponse } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { loadWeeklyReport } from '@/lib/reports/load'
import { weeklyMarkdown } from '@/lib/reports/weekly'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const gate = await opsGate(req)
  if (!gate.ok) return gate.response
  const { agent } = gate
  const format = new URL(req.url).searchParams.get('format') ?? 'json'
  const { report, sample } = await loadWeeklyReport()
  if (format === 'md' || format === 'markdown') {
    return new NextResponse(weeklyMarkdown(report), { headers: { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store' } })
  }
  return NextResponse.json({ ok: true, agent, sample, report }, { headers: { 'Cache-Control': 'no-store' } })
}
