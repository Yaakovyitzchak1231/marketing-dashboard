import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Angles: named message variants attached to campaigns.
 * Attribution is honest: a campaign's metrics flow to its angle only when
 * it is the campaign's sole angle (see collector/sync_angles.py).
 */

export async function GET(request: NextRequest) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { data, error } = await supabase
    .from('angles')
    .select('*, campaigns(name)')
    .order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: 'Failed to fetch angles' }, { status: 500 })
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
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  if (!name) {
    return NextResponse.json({ error: 'name is required' }, { status: 400 })
  }
  const row = {
    name,
    description: typeof body.description === 'string' ? body.description : null,
    campaign_id: typeof body.campaign_id === 'string' ? body.campaign_id : null,
    variant_label: typeof body.variant_label === 'string' ? body.variant_label : null,
  }
  const { data, error } = await supabase
    .from('angles')
    .insert(row)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to create angle' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
