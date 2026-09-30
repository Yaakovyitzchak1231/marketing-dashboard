import { NextRequest, NextResponse } from 'next/server'
import { createServerSupabaseClient } from '@/lib/supabase-server'

export async function POST(request: NextRequest) {
  const supabase = createServerSupabaseClient()
  
  const { error } = await supabase.auth.signOut()
  
  if (error) {
    return NextResponse.json(
      { error: 'Failed to sign out' },
      { status: 500 }
    )
  }
  
  return NextResponse.json({ success: true })
}