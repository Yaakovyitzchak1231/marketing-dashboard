/**
 * getDashboardData(range): everything the dashboard shows for one date range,
 * live from the Instantly API v2, mapped to the contract in lib/dashboard/types.ts.
 *
 * - No INSTANTLY_API_KEY -> configured:false and ZERO network calls.
 * - Independent calls run in parallel (Promise.allSettled); a failed source
 *   becomes an entry in errors[] and its numbers stay null — never 0.
 * - Server-only; responses are cached ~5 minutes by the client.
 *
 * The load is split into stages so the page can stream (see loadStages):
 *   loadSummary  — phase 1, the calls everything else needs: totals, deltas,
 *                  the campaign list, the sending inboxes. Fast.
 *   loadDaily / loadCampaigns / loadAccounts / loadReplies — phase 2, one
 *                  stage per section; started together, awaited on their own.
 * getDashboardData composes them in that order, so /api/dashboard still returns
 * one JSON body and every number is identical to the streamed page.
 */
import 'server-only'
import type {
  CampaignRow, CampaignStatus, Counts, DailyPoint, DashboardData, DateRange, Insight, RangeKey, Rates,
  RepliedLead, SenderAccount, SourceError,
} from '@/lib/dashboard/types'
import { computeInsights, classifyAccountHealth } from '@/lib/insights'
import { InstantlyClient, InstantlyError, clientFromEnv } from '@/lib/instantly/client'
import {
  getAccountDaily, getAnalyticsOverview, getCampaignAnalytics, getDailyAnalytics, getStepAnalytics,
  listAccounts, listCampaigns, listLatestThreadEmails, listLeadsByEmail,
} from '@/lib/instantly/endpoints'
import type {
  ApiAccount, ApiAccountDailyRow, ApiCampaign, ApiCampaignAnalytics, ApiDailyRow, ApiEmail, ApiLead,
} from '@/lib/instantly/types'
import { addDays, chunkRange, dateInZone, previousRange, rangeFor, resolveTimezone } from '@/lib/dashboard/dates'
import {
  EMPTY_COUNTS, accountStatusWord, campaignStatus, combinedTracking, countsFromApi, dailySeries, num,
  openTrackingOff, ratesFrom, ratio, repliedLeadsFrom, stepStats, sumAccountDaily, zeroCounts,
  type Tracking,
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

/** One section's slice: its data, plus the sources that failed for it. */
export interface Stage<T> {
  data: T
  errors: SourceError[]
}

/** Everything phase 2 needs, built once by loadSummary. Server-only; never sent to the browser. */
export interface DashboardContext {
  client: InstantlyClient
  now: Date
  timeZone: string
  range: DateRange
  /** The window the analytics endpoints take: null = all time. */
  apiWindow: { start: string; end: string } | null
  /** First day of the daily chart (the range start, or the oldest campaign). */
  dailyStart: string
  /** Workspace tracking for the campaigns that sent in the range. */
  tracking: Tracking
  ids: string[]
  listed: ApiCampaign[]
  listedById: Map<string, ApiCampaign>
  /** false when the campaign list call failed; inbox membership is then unknown. */
  campaignsOk: boolean
  /** Open/link tracking for one campaign (null = the list did not report it). */
  trackingOf: (id: string) => Tracking
  rangeRows: ApiCampaignAnalytics[] | null
  rangeById: Map<string, ApiCampaignAnalytics>
  lifetimeById: Map<string, ApiCampaignAnalytics>
  perCampaignIds: string[]
  nameOf: (id: string) => string
  campaignNames: Map<string, string>
  threads: ApiEmail[]
  /** false when the /emails call failed, so replies cannot be read. */
  threadsOk: boolean
  accounts: ApiAccount[]
  accountJobs: Array<{ emails: string[]; w: { start: string; end: string } }>
}

/** Phase 1: what the page can show before any per-campaign or per-inbox call. */
export interface DashboardSummary {
  generatedAt: string
  range: DateRange
  configured: boolean
  totals: { counts: Counts; rates: Rates }
  previous: { counts: Counts; rates: Rates } | null
  /** true when the campaign list reports tracking for at least one campaign and every one is off. */
  trackingOff: boolean
  errors: SourceError[]
  /** null when not configured: there is nothing to load. */
  ctx: DashboardContext | null
}

export interface StageResults {
  daily: Stage<DailyPoint[]>
  campaigns: Stage<CampaignRow[]>
  accounts: Stage<SenderAccount[]>
  replies: Stage<RepliedLead[]>
}

export interface Stages {
  daily: Promise<Stage<DailyPoint[]>>
  campaigns: Promise<Stage<CampaignRow[]>>
  accounts: Promise<Stage<SenderAccount[]>>
  replies: Promise<Stage<RepliedLead[]>>
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

// ---- Phase 1 --------------------------------------------------------------------

export async function loadSummary(rangeKey: RangeKey = '30d', opts: LoadOptions = {}): Promise<DashboardSummary> {
  const now = opts.now ?? new Date()
  const timeZone = resolveTimezone(opts.timeZone ?? process.env.DASHBOARD_TZ)
  const range = rangeFor(rangeKey, now, timeZone)
  const prev = previousRange(range)
  const client = opts.client === undefined ? clientFromEnv() : opts.client
  const empty: DashboardSummary = {
    generatedAt: now.toISOString(),
    range,
    configured: false,
    totals: { counts: { ...EMPTY_COUNTS }, rates: ratesFrom(EMPTY_COUNTS) },
    previous: null,
    trackingOff: false,
    errors: [],
    ctx: null,
  }
  if (!client) return empty

  const errors: SourceError[] = []
  const fail = (source: string, err: unknown) => errors.push({ source, message: message(err) })

  // ---- Phase 1: independent calls -------------------------------------------------
  const apiWindow = range.start === null ? null : { start: range.start, end: range.end }
  const [campaignsR, rangeAnaR, lifetimeAnaR, overviewR, prevOverviewR, accountsR, threadsR] = await Promise.allSettled([
    listCampaigns(client),
    getCampaignAnalytics(client, apiWindow),
    getCampaignAnalytics(client, null),
    getAnalyticsOverview(client, apiWindow),
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
  const trackingOf = (id: string): Tracking => {
    const c = listedById.get(id)
    return {
      open: typeof c?.open_tracking === 'boolean' ? c.open_tracking : null,
      link: typeof c?.link_tracking === 'boolean' ? c.link_tracking : null,
    }
  }

  // Workspace tracking = tracking of the campaigns that actually sent in the range.
  // Optimization: use a single pass instead of filter/map chaining
  const sentIds: string[] = []
  if (rangeRows) {
    for (const r of rangeRows) {
      if ((num(r.emails_sent_count) ?? 0) > 0) sentIds.push(r.campaign_id)
    }
  }
  const basis = sentIds.length ? sentIds : ids
  const totalTracking = {
    open: combinedTracking(basis.map((id) => trackingOf(id).open)),
    link: combinedTracking(basis.map((id) => trackingOf(id).link)),
  }

  const overview = value(overviewR)
  if (!overview) fail('campaigns/analytics/overview', (overviewR as PromiseRejectedResult).reason)
  const totalsCounts: Counts = countsFromApi(overview, totalTracking)
  let previous: DashboardSummary['previous'] = null
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

  // ---- Phase 1.5: the shape of phase 2, from what phase 1 already returned ---------
  // Single pass to find the minimum: avoids map/filter/sort intermediate arrays.
  let earliestCreated: number | undefined
  for (const c of listed) {
    const t = c.timestamp_created ? Date.parse(c.timestamp_created) : NaN
    if (Number.isFinite(t) && (earliestCreated === undefined || t < earliestCreated)) {
      earliestCreated = t
    }
  }
  const dailyStart = range.start ?? (earliestCreated !== undefined ? dateInZone(new Date(earliestCreated), timeZone) : addDays(range.end, -(ALL_TIME_FALLBACK_DAYS - 1)))

  // Campaigns worth a per-campaign call: those with activity in the range (when we know it).
  const active = (id: string) => (rangeRows ? rangeById.has(id) : true)
  const perCampaignIds = ids.filter(active)

  const accountsPage = value(accountsR)
  if (!accountsPage) fail('accounts', (accountsR as PromiseRejectedResult).reason)
  else if (accountsPage.truncated) errors.push({ source: 'accounts', message: `Only the first ${accountsPage.items.length} sending accounts were read; there are more.` })
  const accounts = accountsPage?.items ?? []
  // Optimization: collect emails in one pass, avoiding intermediate arrays
  const accountEmails: string[] = []
  for (const a of accounts) {
    if (a.email) accountEmails.push(a.email)
  }

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

  const nameOf = (id: string) =>
    listedById.get(id)?.name ?? rangeById.get(id)?.campaign_name ?? lifetimeById.get(id)?.campaign_name ?? 'Untitled campaign'

  return {
    generatedAt: now.toISOString(),
    range,
    configured: true,
    totals: { counts: totalsCounts, rates: ratesFrom(totalsCounts) },
    previous,
    trackingOff: openTrackingOff(ids.map((id) => trackingOf(id).open)),
    errors,
    ctx: {
      client,
      now,
      timeZone,
      range,
      apiWindow,
      dailyStart,
      tracking: totalTracking,
      ids,
      listed,
      listedById,
      campaignsOk: Boolean(campaignsPage),
      trackingOf,
      rangeRows,
      rangeById,
      lifetimeById,
      perCampaignIds,
      nameOf,
      campaignNames: new Map(ids.map((id) => [id, nameOf(id)])),
      threads: threadsPage?.items ?? [],
      threadsOk: Boolean(threadsPage),
      accounts,
      accountJobs,
    },
  }
}

// ---- Phase 2: one stage per section ---------------------------------------------

/** The daily chart: one point per calendar day, days the API omits are real zeros. */
export async function loadDaily(ctx: DashboardContext): Promise<Stage<DailyPoint[]>> {
  const errors: SourceError[] = []
  let rows: ApiDailyRow[] | null = null
  try {
    rows = await getDailyAnalytics(ctx.client, { start: ctx.dailyStart, end: ctx.range.end })
  } catch (err) {
    errors.push({ source: 'campaigns/analytics/daily', message: message(err) })
  }
  return { data: dailySeries(rows, ctx.dailyStart, ctx.range.end, ctx.tracking), errors }
}

/** One row per campaign, with per-step results and all-time totals. */
export async function loadCampaigns(ctx: DashboardContext): Promise<Stage<CampaignRow[]>> {
  const errors: SourceError[] = []
  const [stepsRs, ovRs] = await Promise.all([
    mapLimit(ctx.perCampaignIds, CAMPAIGN_CONCURRENCY, (id) => getStepAnalytics(ctx.client, id, ctx.apiWindow)),
    mapLimit(ctx.perCampaignIds, CAMPAIGN_CONCURRENCY, (id) => getAnalyticsOverview(ctx.client, ctx.apiWindow, id)),
  ])
  const stepsById = new Map<string, PromiseSettledResult<unknown>>()
  const ovById = new Map<string, PromiseSettledResult<unknown>>()
  ctx.perCampaignIds.forEach((id, i) => {
    stepsById.set(id, stepsRs[i])
    ovById.set(id, ovRs[i])
  })
  let stepFailures = 0
  const campaigns: CampaignRow[] = ctx.ids.map((id) => {
    const t = ctx.trackingOf(id)
    const listedC = ctx.listedById.get(id)
    const rangeRow: ApiCampaignAnalytics | undefined = ctx.rangeById.get(id)
    let counts: Counts
    if (rangeRow) counts = countsFromApi(rangeRow, t)
    else if (ctx.rangeRows) counts = zeroCounts(t) // the range call succeeded and listed no activity
    else counts = { ...EMPTY_COUNTS }
    // Meetings: per-campaign overview (only the overview reports them).
    const ov = ovById.get(id)
    if (ov?.status === 'fulfilled') counts.meetingsBooked = num((ov.value as { total_meeting_booked?: unknown }).total_meeting_booked)
    else if (!ov && ctx.rangeRows) counts.meetingsBooked = 0
    const st = stepsById.get(id)
    let steps: CampaignRow['steps'] = []
    if (st?.status === 'fulfilled') steps = stepStats(st.value as Parameters<typeof stepStats>[0], listedC, t.open)
    else if (st?.status === 'rejected') stepFailures++
    const life = ctx.lifetimeById.get(id)
    const leadsTotal = life ? num(life.leads_count) : rangeRow ? num(rangeRow.leads_count) : null
    const lifeContacted = life ? num(life.new_leads_contacted_count) : null
    const remaining = leadsTotal !== null && lifeContacted !== null ? leadsTotal - lifeContacted : null
    const lifeCounts = life ? countsFromApi(life, t) : null
    return {
      id,
      name: ctx.nameOf(id),
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
  const ovFailures = ovRs.filter((r) => r.status === 'rejected').length
  if (ovFailures) errors.push({ source: 'campaigns/analytics/overview (per campaign)', message: `Meetings booked are missing for ${ovFailures} campaign(s).` })
  // Most activity first; ties by name.
  campaigns.sort((a, b) => (b.counts.sent ?? -1) - (a.counts.sent ?? -1) || a.name.localeCompare(b.name))
  return { data: campaigns, errors }
}

/** One row per sending inbox, with its in-range sent / bounce / reply counts. */
export async function loadAccounts(ctx: DashboardContext): Promise<Stage<SenderAccount[]>> {
  const errors: SourceError[] = []
  const accountRs = await mapLimit(ctx.accountJobs, CAMPAIGN_CONCURRENCY, (j) => getAccountDaily(ctx.client, j.emails, j.w))
  const failedEmails = new Set<string>()
  const accountRows: ApiAccountDailyRow[] = []
  accountRs.forEach((r, i) => {
    if (r.status === 'fulfilled') accountRows.push(...r.value)
    else ctx.accountJobs[i].emails.forEach((e) => failedEmails.add(e.toLowerCase()))
  })
  if (failedEmails.size) {
    const firstErr = accountRs.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined
    errors.push({ source: 'accounts/analytics/daily', message: `Per-inbox numbers are missing for ${failedEmails.size} account(s): ${message(firstErr?.reason)}` })
  }
  const perAccount = sumAccountDaily(accountRows)
  // Which campaigns each inbox sends for (campaign email_list), so old, unused inboxes can be told apart.
  const campaignsByInbox = new Map<string, { id: string; name: string; status: CampaignStatus }[]>()
  // Only trust membership when the campaign list loaded and actually carries sender lists.
  const membershipKnown = ctx.campaignsOk && ctx.listed.some((c) => Array.isArray(c.email_list))
  for (const c of ctx.listed) {
    for (const e of c.email_list ?? []) {
      const key = String(e).toLowerCase()
      const arr = campaignsByInbox.get(key) ?? []
      arr.push({ id: c.id, name: c.name ?? c.id, status: campaignStatus(c.status) })
      campaignsByInbox.set(key, arr)
    }
  }
  const senderAccounts: SenderAccount[] = ctx.accounts.map((a) => {
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
  return { data: senderAccounts, errors }
}

/** Replied leads still waiting on you, newest reply first. */
export async function loadReplies(ctx: DashboardContext): Promise<Stage<RepliedLead[]>> {
  const errors: SourceError[] = []
  // Single pass into a Set: avoids map/filter intermediate arrays.
  const threadContactsSet = new Set<string>()
  for (const e of ctx.threads) {
    const lead = e.lead?.toLowerCase()
    if (lead) threadContactsSet.add(lead)
  }
  const threadContacts = [...threadContactsSet]
  let leads: ApiLead[] | null = []
  if (threadContacts.length) {
    try {
      leads = await listLeadsByEmail(ctx.client, threadContacts)
    } catch (err) {
      leads = null
      errors.push({ source: 'leads/list', message: message(err) })
    }
  }
  const repliedLeads = ctx.threadsOk && leads
    ? repliedLeadsFrom({
        threads: ctx.threads, leads,
        campaignNames: ctx.campaignNames,
        start: ctx.range.start, end: ctx.range.end, timeZone: ctx.timeZone, now: ctx.now, limit: REPLIED_LEADS_LIMIT,
      })
    : []
  return { data: repliedLeads, errors }
}

/** Start every phase-2 stage at once. The caller awaits each one where it renders. */
export function loadStages(ctx: DashboardContext): Stages {
  return {
    daily: loadDaily(ctx),
    campaigns: loadCampaigns(ctx),
    accounts: loadAccounts(ctx),
    replies: loadReplies(ctx),
  }
}

// ---- Assembly -------------------------------------------------------------------

/** Everything except insights, from the summary and the four stages. */
export function combineStages(summary: DashboardSummary, r: StageResults): Omit<DashboardData, 'insights'> {
  return {
    generatedAt: summary.generatedAt,
    range: summary.range,
    configured: summary.configured,
    totals: summary.totals,
    previous: summary.previous,
    daily: r.daily.data,
    campaigns: r.campaigns.data,
    accounts: r.accounts.data,
    repliedLeads: r.replies.data,
    errors: [...summary.errors, ...r.daily.errors, ...r.campaigns.errors, ...r.accounts.errors, ...r.replies.errors],
  }
}

/** The recommendations. A bug in the rules must not take the numbers down with it. */
export function insightsFor(data: Omit<DashboardData, 'insights'>): Stage<Insight[]> {
  try {
    return { data: computeInsights(data), errors: [] }
  } catch {
    return { data: [], errors: [{ source: 'insights', message: 'The recommendations could not be computed from this data.' }] }
  }
}

/** The DashboardData shape when there are no stages to load (not configured): the page's setup card. */
export function emptyFromSummary(summary: DashboardSummary): DashboardData {
  return {
    generatedAt: summary.generatedAt,
    range: summary.range,
    configured: summary.configured,
    totals: summary.totals,
    previous: summary.previous,
    daily: [],
    campaigns: [],
    accounts: [],
    repliedLeads: [],
    insights: [],
    errors: summary.errors,
  }
}

/** One DashboardData for a range, all stages in parallel. The /api/dashboard contract. */
export async function getDashboardData(rangeKey: RangeKey = '30d', opts: LoadOptions = {}): Promise<DashboardData> {
  const summary = await loadSummary(rangeKey, opts)
  if (!summary.ctx) return emptyFromSummary(summary)
  const stages = loadStages(summary.ctx)
  const [daily, campaigns, accounts, replies] = await Promise.all([stages.daily, stages.campaigns, stages.accounts, stages.replies])
  const withoutInsights = combineStages(summary, { daily, campaigns, accounts, replies })
  const insights = insightsFor(withoutInsights)
  return { ...withoutInsights, insights: insights.data, errors: [...withoutInsights.errors, ...insights.errors] }
}
