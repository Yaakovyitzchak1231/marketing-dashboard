import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'

/**
 * Infrastructure health: domains (expiry, DNS) and inboxes (health,
 * warmup). Answers "which inboxes or domains are unhealthy or expire
 * within 14 days?"
 */

const EXPIRY_WINDOW_DAYS = 14

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }

  // Column list follows supabase/migrations/002_unified_model.sql exactly.
  // The schema has no `status`, `dns_healthy` or `dns_last_checked_at` on
  // domains, and no `email_address`, `health_status`, `warmup_enabled` or
  // `last_seen_at` on inboxes — the table's primary key is `email`.
  const { data: domains, error: domError } = await supabase
    .from('domains')
    .select('domain, registrar, expires_at, auto_renew, spf_ok, dkim_ok, dmarc_ok, dns_checked_at')
    .order('expires_at', { ascending: true, nullsFirst: false })
  if (domError) {
    return NextResponse.json({ error: 'Failed to fetch domains' }, { status: 500 })
  }

  const { data: inboxes, error: inboxError } = await supabase
    .from('inboxes')
    .select('email, domain, provider, warmup_status, warmup_score, instantly_connected, instantly_status, checked_at')
    .order('email')
  if (inboxError) {
    return NextResponse.json({ error: 'Failed to fetch inboxes' }, { status: 500 })
  }

  const now = new Date()
  const windowMs = EXPIRY_WINDOW_DAYS * 24 * 60 * 60 * 1000
  const domainRows = ((domains ?? []) as Record<string, unknown>[]).map(d => {
    const expiresAt = d.expires_at ? new Date(d.expires_at as string) : null
    const expiringSoon =
      expiresAt !== null && expiresAt.getTime() - now.getTime() < windowMs
    // DNS health is the conjunction of the three record checks the schema
    // actually stores. Any failed record means unhealthy; all three passing
    // means healthy; anything in between means we have not checked, which is
    // unknown — so it stays null rather than collapsing to true.
    const checks = [d.spf_ok, d.dkim_ok, d.dmarc_ok].map(v =>
      typeof v === 'boolean' ? v : null,
    )
    let dnsHealthy: boolean | null = null
    if (checks.includes(false)) dnsHealthy = false
    else if (checks.every(v => v === true)) dnsHealthy = true
    return {
      domain: d.domain,
      registrar: d.registrar ?? null,
      expires_at: d.expires_at ?? null,
      auto_renew: typeof d.auto_renew === 'boolean' ? d.auto_renew : null,
      dns_healthy: dnsHealthy,
      dns_checked_at: d.dns_checked_at ?? null,
      expiring_soon: expiringSoon,
      unhealthy: dnsHealthy === false,
    }
  })

  const inboxRows = ((inboxes ?? []) as Record<string, unknown>[]).map(i => {
    // The schema stores warmup as a score plus an Instantly connection
    // status. There is no health_status column, so health is reported as
    // null (unknown) rather than invented from the warmup score.
    const warmupScore = typeof i.warmup_score === 'number' ? i.warmup_score : null
    return {
      email_address: (i.email as string) ?? null,
      domain: (i.domain as string) ?? null,
      provider: i.provider ?? null,
      health_status: null,
      warmup_status: i.warmup_status ?? null,
      warmup_score: warmupScore,
      instantly_connected:
        typeof i.instantly_connected === 'boolean' ? i.instantly_connected : null,
      last_seen_at: i.checked_at ?? null,
      unhealthy: false,
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
