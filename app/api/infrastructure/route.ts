import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Infrastructure health: domains (expiry, DNS) and inboxes (health,
 * warmup). Answers "which inboxes or domains are unhealthy or expire
 * within 14 days?"
 */

const EXPIRY_WINDOW_DAYS = 14

export async function GET(request: NextRequest) {
  const supabase = getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  const { data: domains, error: domError } = await supabase
    .from('domains')
    .select('domain, registrar, status, expires_at, auto_renew, dns_healthy, dns_last_checked_at')
    .order('expires_at', { ascending: true, nullsFirst: false })
  if (domError) {
    return NextResponse.json({ error: 'Failed to fetch domains' }, { status: 500 })
  }

  const { data: inboxes, error: inboxError } = await supabase
    .from('inboxes')
    .select('domain, email_address, provider, health_status, warmup_enabled, warmup_score, last_seen_at')
    .order('email_address')
  if (inboxError) {
    return NextResponse.json({ error: 'Failed to fetch inboxes' }, { status: 500 })
  }

  const now = new Date()
  const windowMs = EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const domainRows = ((domains ?? []) as Record<string, unknown>[]).map(d => {
    const expiresAt = d.expires_at ? new Date(d.expires_at as string) : null
    const expiringSoon =
      expiresAt !== null && expiresAt.getTime() - now.getTime() < windowMs
    return {
      ...d,
      expiring_soon: expiringSoon,
      unhealthy: d.dns_healthy === false,
    }
  })

  const inboxRows = ((inboxes ?? []) as Record<string, unknown>[]).map(i => {
    const health = (i.health_status as string | null)?.toLowerCase() ?? null
    return {
      ...i,
      unhealthy: health !== null && health !== 'healthy' && health !== 'active',
    }
  })

  const collectorsBlocked: string[] = []
  if (domainRows.length === 0) collectorsBlocked.push('porkbun')
  if (inboxRows.length === 0) collectorsBlocked.push('inboxkit')

  return NextResponse.json({
    domains: domainRows,
    inboxes: inboxRows,
    expiring_soon_count: domainRows.filter(d => d.expiring_soon).length,
    unhealthy_domain_count: domainRows.filter(d => d.unhealthy).length,
    unhealthy_inbox_count: inboxRows.filter(i => i.unhealthy).length,
    collectors_blocked: collectorsBlocked,
  })
}
