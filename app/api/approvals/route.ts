import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { EDITABLE_ARTIFACTS } from '@/lib/revisions'

const ARTIFACT_TYPES = EDITABLE_ARTIFACTS

export async function GET(req: NextRequest) {
  const supabase = await getRequestClient(req)
  if (!supabase) return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  const url = new URL(req.url)
  const artifactType = url.searchParams.get('artifact_type') ?? ''
  const artifactId = url.searchParams.get('artifact_id') ?? ''
  if (!ARTIFACT_TYPES.includes(artifactType as typeof ARTIFACT_TYPES[number])) {
    return NextResponse.json(
      { error: 'artifact_type must be ideas, costs, or angles' },
      { status: 400 },
    )
  }
  if (!artifactId) {
    return NextResponse.json({ error: 'artifact_id is required' }, { status: 400 })
  }
  const { data, error } = await supabase
    .from('approvals')
    .select('*')
    .eq('artifact_type', artifactType)
    .eq('artifact_id', artifactId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error(`approvals GET: ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch approvals' }, { status: 500 })
  }
  return NextResponse.json((data ?? []) as Array<Record<string, unknown>>)
}
