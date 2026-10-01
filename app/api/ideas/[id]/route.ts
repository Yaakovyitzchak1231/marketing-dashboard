import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

// The writable columns are the ones ideas actually has: title, hypothesis,
// status. There is no name / description / channel_id column, so accepting
// them would make PATCH answer 200 while silently discarding the edit.
const UPDATABLE = ['title', 'hypothesis', 'status'] as const

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
  // `.select('id')` asks Postgres to return the rows it actually removed. There
  // is no DELETE policy on ideas, so RLS hides the row and the delete matches
  // zero rows without raising an error. Checking `error` alone would answer
  // {"ok":true} for a delete that removed nothing, which is exactly the
  // dishonesty this dashboard is not allowed to ship.
  const { data, error } = await supabase.from('ideas').delete().eq('id', id).select('id')
  if (error) {
    console.error(`ideas DELETE: query failed (${error.code}): ${error.message}`)
    return NextResponse.json({ error: 'Failed to delete idea' }, { status: 500 })
  }
  if (!data || data.length === 0) {
    return NextResponse.json(
      { error: 'Idea not found, or not deletable by this user' },
      { status: 404 },
    )
  }
  return NextResponse.json({ ok: true })
}
