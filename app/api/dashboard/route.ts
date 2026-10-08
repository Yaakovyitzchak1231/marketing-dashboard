/**
 * GET /api/dashboard?range=7d|30d|90d  ->  DashboardData (JSON), live from Instantly.
 * The login gate in middleware.ts already protects /api/*.
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDashboardData } from '@/lib/dashboard/load'
import { isSupportedRange, type Range } from '@/lib/range'
import { getRequestClient } from '@/lib/request-client'

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase is not configured' },
      { status: 503 }
    )
  }

  const raw = req.nextUrl.searchParams.get('range') ?? '7d'
  if (!isSupportedRange(raw)) {
    return NextResponse.json({ error: 'range must be one of 7d, 30d, 90d' }, { status: 400 })
  }
  const range: Range = raw
  try {
    const data = await getDashboardData(supabase, range)
    return NextResponse.json(data, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (err) {
    console.error('[dashboard] load failed', err)
    return NextResponse.json(
      { error: 'Could not load the dashboard from Instantly.' },
      { status: 500 }
    )
  }
}