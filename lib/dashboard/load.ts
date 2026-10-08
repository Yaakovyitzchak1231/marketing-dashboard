/**
 * getDashboardData(range): everything the dashboard shows for one date range,
 * live from the Instantly API v2, mapped to the contract in lib/dashboard/types.ts.
 *
 * - No INSTANTLY_API_KEY -> configured:false and ZERO network calls.
 * - Independent calls run in parallel (Promise.allSettled); a failed source
 *   becomes an entry in errors[] and its numbers stay null — never 0.
 * - Server-only; responses are cached ~5 minutes by the client.
 */
import 'server-only'
import type {
  CampaignRow, CampaignStatus, Counts, DashboardData, DateRange, RangeKey, SenderAccount, SourceError,
} from '@/lib/dashboard/types'
import { computeInsights, classifyAccountHealth } from '@/lib/insights'
import { InstantlyClient, InstantlyError, clientFromEnv } from '@/lib/instantly/client'
import {
  getAccountDaily, getAnalyticsOverview, getCampaignAnalytics, getDailyAnalytics, getStepAnalytics,
  listAccounts, listCampaigns, listLatestThreadEmails, listLeadsByEmail,
} from '@/lib/instantly/endpoints'
import type { ApiAccountDailyRow, ApiCampaign, ApiCampaignAnalytics } from '@/lib/instantly/types'
import { addDays, chunkRange, dateInZone, previousRange, rangeFor, resolveTimezone } from '@/lib/dashboard/dates'
import {
  EMPTY_COUNTS, accountStatusWord, campaignStatus, combinedTracking, countsFromApi, dailySeries, num,
  ratesFrom, ratio, repliedLeadsFrom, stepStats, sumAccountDaily, zeroCounts,
} from '@/lib/dashboard/metrics'

/** Instantly allows at most 31 days per /accounts/analytics/daily call. */
export const ACCOUNT_WINDOW_DAYS = 31
/** At most this many 31-day windows (~1 year) of per-inbox history for the all-time range. */
export const MAX_ACCOUNT_WINDOWS = 12
/** Emails per /accounts/analytics/daily call (API max 200; halves itself on 413). */
export const ACCOUNT_BATCH = 100
/** Parallel per-campaign calls. */
export const CAMPAIGN_CONCURRENCY = 4
/** Fallback start for the all-time daily chart when no campaign has a creation date. */
export const ALL_TIME_FALLBACK_DAYS = 365
export const REPLIED_LEADS_LIMIT = 50

export interface LoadOptions {
  /** Injected client (tests). undefined = from env; null = not configured. */
  client?: InstantlyClient | null
  now?: Date
  timeZone?: string
}

function message(err: unknown): string {
  if (err instanceof InstantlyError) return err.message
  return 'Something unexpected went wrong while reading this from Instantly.'
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = { status: 'fulfilled', value: await fn(items[i]) }
      } catch (reason) {
        out[i] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

function value<T>(r: PromiseSettledResult<T>): T | null {
  return r.status === 'fulfilled' ? r.value : null
}

function emptyData(range: DateRange, configured: boolean, now: Date, errors: SourceError[] = []): DashboardData {
  return {
    generatedAt: now.toISOString(),
    range,
    configured,
    totals: { counts: { ...EMPTY_COUNTS }, rates: ratesFrom(EMPTY_COUNTS) },
    previous: null,
    daily: [],
    campaigns: [],
    accounts: [],
    repliedLeads: [],
    insights: [],
    errors,
  }
}

export async function getDashboardData(rangeKey: RangeKey = '30d', opts: LoadOptions = {}): Promise<DashboardData> {
  const now = opts.now ?? new Date()
  const timeZone = resolveTimezone(opts.timeZone ?? process.env.DASHBOARD_TZ)
  const range = rangeFor(rangeKey, now, timeZone)
  const prev = previousRange(range)
  const client = opts.client === undefined ? clientFromEnv() : opts.client
  if (!client) return emptyData(range, false, now)

  const errors: SourceError[] = []
  const fail = (source: string, err: unknown) => errors.push({ source, message: message(err) })

  // ---- Phase 1: independent calls -------------------------------------------------
  const window = range.start === null ? null : { start: range.start, end: range.end }
  const [campaignsR, rangeAnaR, lifetimeAnaR, overviewR, prevOverviewR, accountsR, threadsR] = await Promise.allSettled([
    listCampaigns(client),
    getCampaignAnalytics(client, window),
    getCampaignAnalytics(client, null),
    getAnalyticsOverview(client, window),
    prev ? getAnalyticsOverview(client, { start: prev.start, end: prev.end }) : Promise.resolve(null),
    listAccounts(client),
    listLatestThreadEmails(client),
  ])

  const campaignsPage = value(campaignsR)
  if (!campaignsPage) fail('campaigns', (campaignsR as PromiseRejectedResult).reason)
  else if (campaignsPage.truncated) errors.push({ source: 'campaigns', message: `Only the first ${campaignsPage.items.length} campaigns were read; the list is longer.` })
  const listed: ApiCampaign[] = campaignsPage?.items ?? []
  const listedById = new Map(listed.map((c) => [c.id, c]))

  const rangeRows = value(rangeAnaR)
  if (!rangeRows) fail('campaigns/analytics', (rangeAnaR as PromiseRejectedResult).reason)
  const lifetimeRows = value(lifetimeAnaR)
  if (!lifetimeRows) fail('campaigns/analytics (all time)', (lifetimeAnaR as PromiseRejectedResult).reason)
  const rangeById = new Map((rangeRows ?? []).map((r) => [r.campaign_id, r]))
  const lifetimeById = new Map((lifetimeRows ?? []).map((r) => [r.campaign_id, r]))

  // Every campaign: the list, plus any campaign only the analytics know about.
  const ids: string[] = [...listed.map((c) => c.id)]
  for (const r of [...(lifetimeRows ?? []), ...(rangeRows ?? [])]) if (r.campaign_id && !ids.includes(r.campaign_id)) ids.push(r.campaign_id)
  const tracking = (id: string) => {
    const c = listedById.get(id)
    return {
      open: typeof c?.open_tracking === 'boolean' ? c.open_tracking : null,
      link: typeof c?.link_tracking === 'boolean' ? c.link_tracking : null,
    }
  }

  // Workspace tracking = tracking of the campaigns that actually sent in the range.
  const sentIds = (rangeRows ?? []).filter((r) => (num(r.emails_sent_count) ?? 0) > 0).map((r) => r.campaign_id)
  const basis = sentIds.length ? sentIds : ids
  const totalTracking = {
    open: combinedTracking(basis.map((id) => tracking(id).open)),
    link: combinedTracking(basis.map((id) => tracking(id).link)),
  }

  const overview = value(overviewR)
  if (!overview) fail('campaigns/analytics/overview', (overviewR as PromiseRejectedResult).reason)
  const totalsCounts: Counts = countsFromApi(overview, totalTracking)
  let previous: DashboardData['previous'] = null
  if (prev) {
    const p = value(prevOverviewR)
    if (p) {
      const pc = countsFromApi(p, totalTracking)
      previous = { counts: pc, rates: ratesFrom(pc) }
    } else {
      fail('campaigns/analytics/overview (previous period)', (prevOverviewR as PromiseRejectedResult).reason)
    }
  }
  if (totalsCounts.replied !== null && totalsCounts.contacted !== null && totalsCounts.replied > totalsCounts.contacted) {
    errors.push({
      source: 'reply rate',
      message: `Reply rate isn't meaningful for this range: ${totalsCounts.replied} people replied but only ${totalsCounts.contacted} new leads were first emailed in it (the replies come from earlier sends). Pick a longer range.`,
    })
  }

  // ---- Phase 2: calls that depend on phase 1 --------------------------------------
  const earliestCreated = listed
    .map((c) => (c.timestamp_created ? Date.parse(c.timestamp_created) : NaN))
    .filter((t) => Number.isFinite(t))
    .sort((a, b) => a - b)[0]
  const dailyStart = range.start ?? (earliestCreated !== undefined ? dateInZone(new Date(earliestCreated), timeZone) : addDays(range.end, -(ALL_TIME_FALLBACK_DAYS - 1)))

  // Campaigns worth a per-campaign call: those with activity in the range (when we know it).
  const active = (id: string) => (rangeRows ? rangeById.has(id) : true)
  const perCampaignIds = ids.filter(active)

  const accountsPage = value(accountsR)
  if (!accountsPage) fail('accounts', (accountsR as PromiseRejectedResult).reason)
  else if (accountsPage.truncated) errors.push({ source: 'accounts', message: `Only the first ${accountsPage.items.length} sending accounts were read; there are more.` })
  const accounts = accountsPage?.items ?? []
  const accountEmails = accounts.map((a) => a.email).filter(Boolean)

  let accountWindows = chunkRange(range.start ?? dailyStart, range.end, ACCOUNT_WINDOW_DAYS)
  if (accountWindows.length > MAX_ACCOUNT_WINDOWS) {
    accountWindows = accountWindows.slice(-MAX_ACCOUNT_WINDOWS)
    errors.push({
      source: 'accounts/analytics/daily',
      message: `Per-inbox sent, bounce and reply numbers cover ${accountWindows[0].start} to ${range.end} only (Instantly serves per-inbox history 31 days per request).`,
    })
  }
  const accountJobs: Array<{ emails: string[]; w: { start: string; end: string } }> = []
  for (const w of accountWindows) for (let i = 0; i < accountEmails.length; i += ACCOUNT_BATCH) accountJobs.push({ emails: accountEmails.slice(i, i + ACCOUNT_BATCH), w })

  const threadsPage = value(threadsR)
  if (!threadsPage) fail('emails', (threadsR as PromiseRejectedResult).reason)
  const threads = threadsPage?.items ?? []
  const threadContacts = [...new Set(threads.map((e) => e.lead?.toLowerCase()).filter((x): x is string => !!x))]

  const [dailyR, stepsRs, campaignOverviewRs, accountRs, leadsR] = await Promise.all([
    getDailyAnalytics(client, { start: dailyStart, end: range.end }).then(
      (v) => ({ status: 'fulfilled', value: v }) as PromiseSettledResult<Awaited<ReturnType<typeof getDailyAnalytics>>>,
      (reason) => ({ status: 'rejected', reason }) as PromiseSettledResult<never>,
    ),
    mapLimit(perCampaignIds, CAMPAIGN_CONCURRENCY, (id) => getStepAnalytics(client, id, window)),
    mapLimit(perCampaignIds, CAMPAIGN_CONCURRENCY, (id) => getAnalyticsOverview(client, window, id)),
    mapLimit(accountJobs, CAMPAIGN_CONCURRENCY, (j) => getAccountDaily(client, j.emails, j.w)),
    threadContacts.length
      ? listLeadsByEmail(client, threadContacts).then(
          (v) => ({ status: 'fulfilled', value: v }) as PromiseSettledResult<Awaited<ReturnType<typeof listLeadsByEmail>>>,
          (reason) => ({ status: 'rejected', reason }) as PromiseSettledResult<never>,
        )
      : Promise.resolve({ status: 'fulfilled', value: [] } as PromiseSettledResult<Awaited<ReturnType<typeof listLeadsByEmail>>>),
  ])

  // Daily
  const dailyRows = value(dailyR)
  if (!dailyRows) fail('campaigns/analytics/daily', (dailyR as PromiseRejectedResult).reason)
  const daily = dailySeries(dailyRows, dailyStart, range.end, totalTracking)

  // Campaign rows
  const stepsById = new Map<string, PromiseSettledResult<unknown>>()
  const ovById = new Map<string, PromiseSettledResult<unknown>>()
  perCampaignIds.forEach((id, i) => {
    stepsById.set(id, stepsRs[i])
    ovById.set(id, campaignOverviewRs[i])
  })
  const nameOf = (id: string) =>
    listedById.get(id)?.name ?? rangeById.get(id)?.campaign_name ?? lifetimeById.get(id)?.campaign_name ?? 'Untitled campaign'
  let stepFailures = 0
  const campaigns: CampaignRow[] = ids.map((id) => {
    const t = tracking(id)
    const listedC = listedById.get(id)
    const rangeRow: ApiCampaignAnalytics | undefined = rangeById.get(id)
    let counts: Counts
    if (rangeRow) counts = countsFromApi(rangeRow, t)
    else if (rangeRows) counts = zeroCounts(t) // the range call succeeded and listed no activity
    else counts = { ...EMPTY_COUNTS }
    // Meetings: per-campaign overview (only the overview reports them).
    const ov = ovById.get(id)
    if (ov?.status === 'fulfilled') counts.meetingsBooked = num((ov.value as { total_meeting_booked?: unknown }).total_meeting_booked)
    else if (!ov && rangeRows) counts.meetingsBooked = 0
    const st = stepsById.get(id)
    let steps: CampaignRow['steps'] = []
    if (st?.status === 'fulfilled') steps = stepStats(st.value as Parameters<typeof stepStats>[0], listedC, t.open)
    else if (st?.status === 'rejected') stepFailures++
    const life = lifetimeById.get(id)
    const leadsTotal = life ? num(life.leads_count) : rangeRow ? num(rangeRow.leads_count) : null
    const lifeContacted = life ? num(life.new_leads_contacted_count) : null
    const remaining = leadsTotal !== null && lifeContacted !== null ? leadsTotal - lifeContacted : null
    const lifeCounts = life ? countsFromApi(life, t) : null
    return {
      id,
      name: nameOf(id),
      status: campaignStatus(listedC?.status ?? rangeRow?.campaign_status ?? life?.campaign_status),
      openTracking: t.open,
      counts,
      rates: ratesFrom(counts),
      steps,
      leadsTotal,
      leadsRemaining: remaining !== null && remaining >= 0 ? remaining : null,
      lifetime: lifeCounts ? { counts: lifeCounts, rates: ratesFrom(lifeCounts) } : null,
    }
  })
  if (stepFailures) {
    const firstErr = stepsRs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    errors.push({ source: 'campaigns/analytics/steps', message: `Step results are missing for ${stepFailures} campaign(s): ${message(firstErr?.reason)}` })
  }
  const ovFailures = campaignOverviewRs.filter((r) => r.status === 'rejected').length
  if (ovFailures) errors.push({ source: 'campaigns/analytics/overview (per campaign)', message: `Meetings booked are missing for ${ovFailures} campaign(s).` })
  // Most activity first; ties by name.
  campaigns.sort((a, b) => (b.counts.sent ?? -1) - (a.counts.sent ?? -1) || a.name.localeCompare(b.name))

  // Sending accounts
  const failedEmails = new Set<string>()
  const accountRows: ApiAccountDailyRow[] = []
  accountRs.forEach((r, i) => {
    if (r.status === 'fulfilled') accountRows.push(...r.value)
    else accountJobs[i].emails.forEach((e) => failedEmails.add(e.toLowerCase()))
  })
  if (failedEmails.size) {
    const firstErr = accountRs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    errors.push({ source: 'accounts/analytics/daily', message: `Per-inbox numbers are missing for ${failedEmails.size} account(s): ${message(firstErr?.reason)}` })
  }
  const perAccount = sumAccountDaily(accountRows)
  // Which campaigns each inbox sends for (campaign email_list), so old, unused inboxes can be told apart.
  const campaignsByInbox = new Map<string, { id: string; name: string; status: CampaignStatus }[]>()
  // Only trust membership when the campaign list loaded and actually carries sender lists.
  const membershipKnown = Boolean(campaignsPage) && listed.some((c) => Array.isArray(c.email_list))
  for (const c of listed) {
    for (const e of c.email_list ?? []) {
      const key = String(e).toLowerCase()
      const arr = campaignsByInbox.get(key) ?? []
      arr.push({ id: c.id, name: c.name ?? c.id, status: campaignStatus(c.status) })
      campaignsByInbox.set(key, arr)
    }
  }
  const senderAccounts: SenderAccount[] = accounts.map((a) => {
    const k = a.email.toLowerCase()
    const known = !failedEmails.has(k)
    const tot = perAccount.get(k) ?? { sent: 0, bounced: 0, replied: 0 }
    const sent = known ? tot.sent : null
    const bounced = known ? tot.bounced : null
    const onCampaigns = membershipKnown ? (campaignsByInbox.get(k) ?? []) : null
    const base = {
      email: a.email,
      status: accountStatusWord(a.status),
      warmupScore: num(a.stat_warmup_score),
      dailyLimit: num(a.daily_limit),
      sent,
      bounced,
      replied: known ? tot.replied : null,
      bounceRate: ratio(bounced, sent),
      campaigns: onCampaigns,
      inActiveCampaign: onCampaigns ? onCampaigns.some((c) => c.status === 'active') : null,
    }
    return { ...base, ...classifyAccountHealth(base) }
  })
  // Inboxes on active campaigns first, then by volume.
  senderAccounts.sort((x, y) => Number(y.inActiveCampaign === true) - Number(x.inActiveCampaign === true) || (y.sent ?? -1) - (x.sent ?? -1) || x.email.localeCompare(y.email))

  // Replied leads
  const leads = value(leadsR)
  if (!leads) fail('leads/list', (leadsR as PromiseRejectedResult).reason)
  const repliedLeads = threadsPage && leads
    ? repliedLeadsFrom({
        threads, leads,
        campaignNames: new Map(ids.map((id) => [id, nameOf(id)])),
        start: range.start, end: range.end, timeZone, now, limit: REPLIED_LEADS_LIMIT,
      })
    : []

  const withoutInsights: Omit<DashboardData, 'insights'> = {
    generatedAt: now.toISOString(),
    range,
    configured: true,
    totals: { counts: totalsCounts, rates: ratesFrom(totalsCounts) },
    previous,
    daily,
    campaigns,
    accounts: senderAccounts,
    repliedLeads,
    errors,
  }
  let insights: DashboardData['insights'] = []
  try {
    insights = computeInsights(withoutInsights)
  } catch {
    errors.push({ source: 'insights', message: 'The recommendations could not be computed from this data.' })
  }
  return { ...withoutInsights, insights }
}
