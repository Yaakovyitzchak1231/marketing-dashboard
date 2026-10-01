import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

const UPDATABLE = ['name', 'description', 'channel_id', 'status'] as const

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await getRequestClient(request)
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
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('ideas')
    .update(patch)
    .eq('id', id)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to update idea' }, { status: 500 })
  }
  return NextResponse.json(data)
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { id } = await params
  const { error } = await supabase.from('ideas').delete().eq('id', id)
  if (error) {
    return NextResponse.json({ error: 'Failed to delete idea' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
