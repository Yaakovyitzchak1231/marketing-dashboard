/**
 * Typed, read-only Instantly API v2 calls. One function per endpoint; the
 * mapping to the dashboard contract lives in lib/dashboard/metrics.ts.
 */
import 'server-only'
import { InstantlyClient, InstantlyError, type Page } from '@/lib/instantly/client'
import type {
  ApiAccount, ApiAccountDailyRow, ApiAnalyticsOverview, ApiCampaign, ApiCampaignAnalytics,
  ApiDailyRow, ApiEmail, ApiLead, ApiStepRow,
} from '@/lib/instantly/types'

/** Inclusive calendar dates (YYYY-MM-DD). start null = all time. */
export interface DayWindow {
  start: string | null
  end: string
}

function dateQuery(w: DayWindow | null) {
  if (!w || w.start === null) return {}
  return { start_date: w.start, end_date: w.end }
}

/** GET /campaigns, every page. */
export function listCampaigns(c: InstantlyClient): Promise<Page<ApiCampaign>> {
  return c.paginate<ApiCampaign>('/campaigns', { limit: 100, maxPages: 20 })
}

/** GET /campaigns/analytics — one row per campaign with activity in the window (all campaigns when no window). */
export async function getCampaignAnalytics(c: InstantlyClient, w: DayWindow | null): Promise<ApiCampaignAnalytics[]> {
  const rows = await c.get<ApiCampaignAnalytics[]>('/campaigns/analytics', dateQuery(w))
  if (!Array.isArray(rows)) throw new InstantlyError('Instantly returned campaign analytics in an unexpected shape.', '/campaigns/analytics', 200)
  return rows
}

/** GET /campaigns/analytics/overview — workspace totals, or one campaign's when `campaignId` is set. */
export async function getAnalyticsOverview(c: InstantlyClient, w: DayWindow | null, campaignId?: string): Promise<ApiAnalyticsOverview> {
  const o = await c.get<ApiAnalyticsOverview>('/campaigns/analytics/overview', { ...dateQuery(w), id: campaignId })
  if (!o || typeof o !== 'object' || Array.isArray(o)) {
    throw new InstantlyError('Instantly returned the analytics overview in an unexpected shape.', '/campaigns/analytics/overview', 200)
  }
  return o
}

/** GET /campaigns/analytics/daily — all campaigns. Days with no activity are omitted by the API. */
export async function getDailyAnalytics(c: InstantlyClient, w: { start: string; end: string }, campaignId?: string): Promise<ApiDailyRow[]> {
  const rows = await c.get<ApiDailyRow[]>('/campaigns/analytics/daily', { start_date: w.start, end_date: w.end, campaign_id: campaignId })
  if (!Array.isArray(rows)) throw new InstantlyError('Instantly returned daily analytics in an unexpected shape.', '/campaigns/analytics/daily', 200)
  return rows
}

/** GET /campaigns/analytics/steps for one campaign, with opportunity counts per step. */
export async function getStepAnalytics(c: InstantlyClient, campaignId: string, w: DayWindow | null): Promise<ApiStepRow[]> {
  const rows = await c.get<ApiStepRow[]>('/campaigns/analytics/steps', {
    campaign_id: campaignId, ...dateQuery(w), include_opportunities_count: true,
  })
  if (!Array.isArray(rows)) throw new InstantlyError('Instantly returned step analytics in an unexpected shape.', '/campaigns/analytics/steps', 200)
  return rows
}

/** GET /accounts, every page. */
export function listAccounts(c: InstantlyClient): Promise<Page<ApiAccount>> {
  return c.paginate<ApiAccount>('/accounts', { limit: 100, maxPages: 20 })
}

/**
 * GET /accounts/analytics/daily for a set of sending accounts and one window
 * (the API allows at most 31 days and 200 emails per call). On 413 ("too
 * large for this workspace") the batch is split in half and retried.
 */
export async function getAccountDaily(
  c: InstantlyClient, emails: string[], w: { start: string; end: string },
): Promise<ApiAccountDailyRow[]> {
  if (emails.length === 0) return []
  try {
    const rows = await c.get<ApiAccountDailyRow[]>('/accounts/analytics/daily', {
      start_date: w.start, end_date: w.end, emails,
    })
    if (!Array.isArray(rows)) throw new InstantlyError('Instantly returned account analytics in an unexpected shape.', '/accounts/analytics/daily', 200)
    return rows
  } catch (err) {
    if (err instanceof InstantlyError && err.status === 413 && emails.length > 1) {
      const mid = Math.ceil(emails.length / 2)
      const [a, b] = await Promise.all([
        getAccountDaily(c, emails.slice(0, mid), w),
        getAccountDaily(c, emails.slice(mid), w),
      ])
      return [...a, ...b]
    }
    throw err
  }
}

/**
 * GET /emails?email_type=received&latest_of_thread=true — for every thread that
 * has a received email, the thread's LATEST email (verified live: a thread
 * whose last message is our campaign follow-up comes back as ue_type 1). So
 * ue_type 2 here means the lead spoke last. Range-independent on purpose, so
 * the 20 requests/minute limit is shared by every range through the cache.
 */
export function listLatestThreadEmails(c: InstantlyClient, maxPages = 2): Promise<Page<ApiEmail>> {
  return c.paginate<ApiEmail>('/emails', {
    query: { email_type: 'received', latest_of_thread: true, preview_only: true, mode: 'emode_all' },
    limit: 100,
    maxPages,
  })
}

/** POST /leads/list filtered to the given contact emails (read-only list call). */
export async function listLeadsByEmail(c: InstantlyClient, emails: string[]): Promise<ApiLead[]> {
  const out: ApiLead[] = []
  for (let i = 0; i < emails.length; i += 50) {
    const chunk = emails.slice(i, i + 50)
    const page = await c.paginate<ApiLead>('/leads/list', { method: 'POST', body: { contacts: chunk }, limit: 100, maxPages: 5 })
    out.push(...page.items)
  }
  return out
}
