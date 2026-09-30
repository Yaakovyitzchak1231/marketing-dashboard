import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Costs: manual spend entry. Amounts are stored in the currency given;
 * the dashboard converts only when an explicit rate is supplied.
 * GET lists (optional ?idea_id= / ?campaign_id=), POST creates.
 */

export async function GET(request: NextRequest) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { searchParams } = new URL(request.url)
  let query = supabase
    .from('costs')
    .select('*, ideas(name)')
    .order('spent_at', { ascending: false })
    .limit(500)
  const ideaId = searchParams.get('idea_id')
  const campaignId = searchParams.get('campaign_id')
  if (ideaId) query = query.eq('idea_id', ideaId)
  if (campaignId) query = query.eq('campaign_id', campaignId)
  const { data, error } = await query
  if (error) {
    return NextResponse.json({ error: 'Failed to fetch costs' }, { status: 500 })
  }
  return NextResponse.json(data ?? [])
}

export async function POST(request: NextRequest) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const amount = Number(body.amount_usd)
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: 'amount_usd must be a non-negative number' }, { status: 400 })
  }
  const row = {
    amount_usd: amount,
    category: typeof body.category === 'string' ? body.category : 'other',
    idea_id: typeof body.idea_id === 'string' ? body.idea_id : null,
    campaign_id: typeof body.campaign_id === 'string' ? body.campaign_id : null,
    spent_at: typeof body.spent_at === 'string' ? body.spent_at : new Date().toISOString().split('T')[0],
    notes: typeof body.notes === 'string' ? body.notes : null,
  }
  const { data, error } = await supabase
    .from('costs')
    .insert(row)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to record cost' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
