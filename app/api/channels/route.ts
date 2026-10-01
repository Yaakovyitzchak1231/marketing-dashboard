import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { data, error } = await supabase
    .from('channels')
    .select('*')
    .order('name')
  if (error) {
    return NextResponse.json({ error: 'Failed to fetch channels' }, { status: 500 })
  }
  return NextResponse.json(data ?? [])
}
