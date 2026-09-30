import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

const UPDATABLE = ['amount_usd', 'category', 'idea_id', 'campaign_id', 'spent_at', 'notes'] as const

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { id } = await params
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const patch: Record<string, unknown> = {}
  for (const key of UPDATABLE) {
    if (key in body) patch[key] = body[key]
  }
  if ('amount_usd' in patch) {
    const amount = Number(patch.amount_usd)
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: 'amount_usd must be a non-negative number' }, { status: 400 })
    }
    patch.amount_usd = amount
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('costs')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to update cost' }, { status: 500 })
  }
  return NextResponse.json(data)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { id } = await params
  const { error } = await supabase.from('costs').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: 'Failed to delete cost' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
