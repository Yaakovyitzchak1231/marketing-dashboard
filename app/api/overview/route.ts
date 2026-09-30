import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Request-scoped Supabase client that carries the caller's session.
 *
 * The previous import was `@/lib/supabase`, a lazily-created BROWSER client.
 * It has no access to the request cookies and no service-role key, so every
 * query went out unauthenticated and the middleware rejected it with 401. The
 * dashboard rendered empty because the data layer could never authenticate.
 *
 * This uses the anon key (never the service-role key, which bypasses RLS) plus
 * the caller's own access token, so PostgREST enforces row-level security
 * against the real signed-in user. That is what a private dashboard must do.
 */
function getRequestClient(request: NextRequest): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !anonKey) return null

  const header = request.headers.get('authorization') || ''
  const token = header.startsWith('Bearer ') ? header.slice(7) : null

  return createClient(url, anonKey, {
    global: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function GET(request: NextRequest) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json(
      { error: 'Supabase is not configured' },
      { status: 503 }
    )
  }

  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '7d'
  
  // Calculate date range
  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 7
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]
  
  try {
    // Get account-wide rollup from accounts table
    const { data: accountData, error: accountError } = await supabase
      .from('accounts')
      .select('*')
      .gte('metric_date', cutoffStr)
      .order('metric_date', { ascending: false })
      .limit(1)
      .single()
    
    if (accountError && accountError.code !== 'PGRST116') {
      throw accountError
    }
    
    // If no account data, return nulls for everything
    if (!accountData) {
      return NextResponse.json({
        emails_sent: null,
        replies_human: null,
        replies_autoresponder: null,
        bounces: null,
        opportunities: null,
        opportunity_value: null,
        mailbox_count: null,
        healthy_mailboxes: null,
        reply_rate: null,
        bounce_rate: null,
        open_rate: null,
        unsubscribe: null,
        range
      })
    }
    
    // Compute rates from raw counts (never average a rate)
    const sent = accountData.emails_sent
    const repliesHuman = accountData.replies_human
    const repliesAuto = accountData.replies_autoresponder
    const bounces = accountData.bounces
    
    const replyRate = sent && sent > 0 && repliesHuman !== null
      ? Math.round((repliesHuman / sent) * 10000) / 10000
      : null
    
    const bounceRate = sent && sent > 0 && bounces !== null
      ? Math.round((bounces / sent) * 10000) / 10000
      : null
    
    return NextResponse.json({
      emails_sent: accountData.emails_sent ?? null,
      replies_human: accountData.replies_human ?? null,
      replies_autoresponder: accountData.replies_autoresponder ?? null,
      bounces: accountData.bounces ?? null,
      opportunities: accountData.opportunities ?? null,
      opportunity_value: accountData.opportunity_value ?? null,
      mailbox_count: accountData.mailbox_count ?? null,
      healthy_mailboxes: accountData.healthy_mailboxes ?? null,
      reply_rate: replyRate,
      bounce_rate: bounceRate,
      open_rate: null,
      unsubscribe: null,
      range
    })
  } catch (error) {
    console.error('Overview API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch overview data' },
      { status: 500 }
    )
  }
}