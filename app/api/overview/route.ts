import { NextResponse } from 'next/server'
import { supabase } from '@/lib/supabase'
import { rateFrom, openRateFrom, unsubRateFrom } from '@/lib/rates'

/**
 * Account-wide KPI row.
 *
 * RATE SOURCE: this endpoint rates from `accounts`, which stores the overview
 * endpoint's counters verbatim. It does not aggregate daily_metrics, because
 * the two sources disagree on this account whenever a campaign fails to
 * collect, and AGENTS.md says surface the mismatch rather than pick a winner:
 *
 *   accounts.emails_sent = 45,545  (INSTANTLY_CAMPAIGNS_ANALYTICS_OVERVIEW_GET)
 *   sum(daily_metrics)   = 33,686  during a 3-campaign-failed run (QA's figure)
 *
 * They agree only when every campaign succeeds. `partial` plus both campaign
 * counts are returned so the UI can say which one it is showing rather than
 * quietly rendering whichever number it happens to hold.
 *
 * `replies_human` does not exist and never will -- see migration 002.
 * reply_count_unique and reply_count_automatic_unique are independent counters
 * over different populations, so the rollup carries both raw and neither is
 * derived from the other.
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const range = searchParams.get('range') || '7d'

  const days = range === '7d' ? 7 : range === '30d' ? 30 : range === '90d' ? 90 : 7
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  const cutoffStr = cutoffDate.toISOString().split('T')[0]

  const empty = {
    emails_sent: null,
    replies_unique: null,
    replies_automatic_unique: null,
    replies_all: null,
    bounces: null,
    unsubscribed: null,
    opportunities: null,
    opportunity_value: null,
    contacted: null,
    new_leads_contacted: null,
    opens_unique: null,
    // Null, not 0. A failed INSTANTLY_LIST_ACCOUNTS must never read as
    // "0 mailboxes" -- that is a claim about the fleet we cannot support.
    mailbox_count: null,
    healthy_mailboxes: null,
    warmup_score_avg: null,
    reply_rate: null,
    reply_rate_trusted: false,
    reply_rate_denominator: null,
    reply_rate_denominator_source: 'emails_sent',
    reply_rate_reason: 'not_collected',
    bounce_rate: null,
    bounce_rate_trusted: false,
    bounce_rate_reason: 'not_collected',
    open_rate: null,
    unsubscribe_rate: null,
    partial: true,
    campaigns_inventory_count: null,
    campaigns_collected_count: null,
    open_reported: false,
    unsub_reported: false,
    range,
  }

  try {
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

    if (!accountData) return NextResponse.json(empty)

    const sent = accountData.emails_sent ?? null
    const partial = Boolean(accountData.partial)

    const reply = rateFrom({
      numerator: accountData.replies_unique ?? null,
      denominator: sent,
      denominatorSource: 'emails_sent',
      partial,
    })

    const bounce = rateFrom({
      numerator: accountData.bounces ?? null,
      denominator: sent,
      denominatorSource: 'emails_sent',
      partial,
    })

    const openRate = openRateFrom({
      opensUnique: accountData.opens_unique ?? null,
      reported: Boolean(accountData.open_reported),
      denominator: sent,
    })

    const unsubRate = unsubRateFrom({
      unsubscribed: accountData.unsubscribed ?? null,
      reported: Boolean(accountData.unsub_reported),
      denominator: sent,
    })

    return NextResponse.json({
      emails_sent: sent,
      replies_unique: accountData.replies_unique ?? null,
      replies_automatic_unique: accountData.replies_automatic_unique ?? null,
      replies_all: accountData.replies_all ?? null,
      bounces: accountData.bounces ?? null,
      unsubscribed: accountData.unsubscribed ?? null,
      opportunities: accountData.opportunities ?? null,
      opportunity_value: accountData.opportunity_value ?? null,
      contacted: accountData.contacted_count ?? null,
      new_leads_contacted: accountData.new_leads_contacted ?? null,
      opens_unique: accountData.opens_unique ?? null,
      mailbox_count: accountData.mailbox_count ?? null,
      healthy_mailboxes: accountData.healthy_mailboxes ?? null,
      warmup_score_avg: accountData.warmup_score_avg ?? null,

      reply_rate: reply.value,
      reply_rate_trusted: reply.trusted,
      reply_rate_denominator: reply.denominator,
      reply_rate_denominator_source: reply.denominatorSource,
      reply_rate_reason: reply.reason,

      bounce_rate: bounce.value,
      bounce_rate_trusted: bounce.trusted,
      bounce_rate_reason: bounce.reason,

      open_rate: openRate,
      unsubscribe_rate: unsubRate,

      partial,
      campaigns_inventory_count: accountData.campaigns_inventory_count ?? null,
      campaigns_collected_count: accountData.campaigns_collected_count ?? null,
      open_reported: Boolean(accountData.open_reported),
      unsub_reported: Boolean(accountData.unsub_reported),
      collected_at: accountData.collected_at,
      range,
    })
  } catch (error) {
    console.error('Overview API error:', error)
    return NextResponse.json(
      { error: 'Failed to fetch overview data', ...empty },
      { status: 500 }
    )
  }
}
