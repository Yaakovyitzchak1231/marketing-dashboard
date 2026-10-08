import type { SupabaseClient } from '@supabase/supabase-js'
import type { Range } from '@/lib/range'
import type { Overview } from '@/lib/api-types'

/**
 * The dashboard data payload returned by GET /api/dashboard.
 * Combines account-wide rollup with the campaign list so the shell
 * can render everything in one request.
 */
export type DashboardData = {
  overview: Overview
  campaigns: {
    id: string
    external_id: string | null
    name: string
    status: string | null
    created_at: string | null
    emails_sent: number | null
    replies_human: number | null
    replies_autoresponder: number | null
    bounces: number | null
    opportunities: number | null
    reply_rate: number | null
    bounce_rate: number | null
    open_rate: number | null
    unsubscribe: number | null
    metric_date: string | null
  }[]
  range: Range
}

/**
 * Returns the timestamp of the most recent collection run.
 * Mirrors the logic in app/api/overview/route.ts.
 */
async function lastCollectionRanAt(supabase: SupabaseClient): Promise<string | null> {
  const { data } = await supabase
    .from('collection_runs')
    .select('ran_at')
    .order('ran_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  return data?.ran_at ?? null
}

/**
 * Calculates the date cutoff string for a given range.
 */
function cutoffForRange(range: Range): string {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const cutoffDate = new Date()
  cutoffDate.setDate(cutoffDate.getDate() - days)
  return cutoffDate.toISOString().split('T')[0]
}

/**
 * Computes rates from raw counts — never average a rate.
 * Returns null when the denominator is missing or zero.
 */
function computeRate(numerator: number | null, denominator: number | null): number | null {
  if (denominator === null || denominator === 0 || numerator === null) return null
  return Math.round((numerator / denominator) * 10000) / 10000
}

/**
 * Fetches the account-wide overview for the given range.
 */
async function fetchOverview(supabase: SupabaseClient, range: Range): Promise<Overview> {
  const cutoffStr = cutoffForRange(range)

  const { data: accountData, error: accountError } = await supabase
    .from('accounts')
    .select('*')
    .gte('metric_date', cutoffStr)
    .order('metric_date', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (accountError && accountError.code !== 'PGRST116') {
    throw accountError
  }

  const sent = accountData?.emails_sent ?? null
  const repliesHuman = accountData?.replies_human ?? null
  const repliesAuto = accountData?.replies_autoresponder ?? null
  const bounces = accountData?.bounces ?? null

  const replyRate = computeRate(repliesHuman, sent)
  const bounceRate = computeRate(bounces, sent)

  const generatedAt = await lastCollectionRanAt(supabase)

  return {
    emails_sent: accountData?.emails_sent ?? null,
    replies_human: accountData?.replies_human ?? null,
    replies_autoresponder: accountData?.replies_autoresponder ?? null,
    bounces: accountData?.bounces ?? null,
    opportunities: accountData?.opportunities ?? null,
    opportunity_value: accountData?.opportunity_value ?? null,
    mailbox_count: accountData?.mailbox_count ?? null,
    healthy_mailboxes: accountData?.healthy_mailboxes ?? null,
    reply_rate: replyRate,
    bounce_rate: bounceRate,
    open_rate: null,
    unsubscribe: null,
    range,
    generated_at: generatedAt,
  }
}

/**
 * Fetches the campaign list for the given range.
 */
async function fetchCampaigns(supabase: SupabaseClient, range: Range) {
  const cutoffStr = cutoffForRange(range)

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select(`
      id,
      external_id,
      name,
      status,
      created_at,
      daily_metrics!inner (
        metric_date,
        emails_sent,
        replies_total,
        replies_human,
        replies_autoresponder,
        opportunities,
        bounces,
        open_rate,
        unsubscribe
      )
    `)
    .gte('daily_metrics.metric_date', cutoffStr)
    .order('metric_date', { ascending: false, referencedTable: 'daily_metrics' })
    .limit(100)

  if (error) throw error

  return (campaigns ?? []).map((campaign) => {
    const metrics = campaign.daily_metrics?.[0] ?? {}
    const sent = metrics.emails_sent ?? null
    const repliesHuman = metrics.replies_human ?? null
    const repliesAuto = metrics.replies_autoresponder ?? null
    const bounces = metrics.bounces ?? null
    const opportunities = metrics.opportunities ?? null

    const replyRate = computeRate(repliesHuman, sent)
    const bounceRate = computeRate(bounces, sent)

    return {
      id: campaign.id,
      external_id: campaign.external_id,
      name: campaign.name,
      status: campaign.status,
      created_at: campaign.created_at,
      emails_sent: sent,
      replies_human: repliesHuman,
      replies_autoresponder: repliesAuto,
      bounces: bounces,
      opportunities: opportunities,
      reply_rate: replyRate,
      bounce_rate: bounceRate,
      open_rate: metrics.open_rate ?? null,
      unsubscribe: metrics.unsubscribe ?? null,
      metric_date: metrics.metric_date ?? null,
    }
  })
}

/**
 * Main entry point: loads the combined dashboard data for a range.
 */
export async function getDashboardData(
  supabase: SupabaseClient,
  range: Range
): Promise<DashboardData> {
  const [overview, campaigns] = await Promise.all([
    fetchOverview(supabase, range),
    fetchCampaigns(supabase, range),
  ])

  return { overview, campaigns, range }
}