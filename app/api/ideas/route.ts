import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Ideas: the manual entry point for "what are we trying?".
 * GET lists, POST creates. Writes go through RLS as the signed-in user.
 */

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { data, error } = await supabase
    .from('ideas')
    .select('*, channels(name)')
    .order('created_at', { ascending: false })
  if (error) {
    return NextResponse.json({ error: 'Failed to fetch ideas' }, { status: 500 })
  }
  return NextResponse.json(data ?? [])
}

export async function POST(request: NextRequest) {
  const supabase = await getRequestClient(request)
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
    channel_id: typeof body.channel_id === 'string' ? body.channel_id : null,
    status: typeof body.status === 'string' ? body.status : 'draft',
  }
  const { data, error } = await supabase
    .from('ideas')
    .insert(row)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to create idea' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
