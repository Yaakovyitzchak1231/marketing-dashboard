/**
 * GET /api/dashboard?range=7d|14d|30d|90d|all  ->  DashboardData (JSON), live from Instantly.
 * The login gate in middleware.ts already protects /api/*.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/dashboard/load'
import { isRangeKey } from '@/lib/dashboard/dates'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get('range') ?? '30d'
  if (!isRangeKey(raw)) {
    return NextResponse.json({ error: 'range must be one of 7d, 14d, 30d, 90d, all' }, { status: 400 })
  }
  try {
    const data = await getDashboardData(raw)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ error: 'Could not load the dashboard from Instantly.' }, { status: 502 })
  }
}
