import { describe, it, expect } from 'vitest'
import { WarmblyClient, WarmblyError, apiBase } from '@/lib/warmbly/client'
import { campaignRow, mailboxRow, readWarmblySnapshot } from '@/lib/warmbly/snapshot'

// TAP-118. Shapes below are Warmbly v0.6.47's own: the empty-org answers are
// verbatim from his instance on Oct 13, 2026 (read with the dashboard's
// read-only key); the mailbox/campaign rows use the real column names of his
// email_accounts / campaigns tables with made-up values.

type Call = { url: string; init: RequestInit }

function fakeFetch(routes: Record<string, { status?: number; body: unknown }>) {
  const calls: Call[] = []
  const impl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input)
    calls.push({ url, init })
    const path = new URL(url).pathname
    const r = routes[path]
    if (!r) return new Response('404 page not found', { status: 404 })
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { impl, calls }
}

const EMPTY_PAGE = { data: [], pagination: { total: 0, next_cursor: null, has_more: false } }
const ME = { user_id: 'u1', email: 'yaakov-tab@mail.tab.bot', organization_name: 'TapDash', auth_type: 'api_key', scopes: ['read_analytics', 'read_campaigns', 'read_emails'] }
const WARMUP_EMPTY = {
  email_account_id: '00000000-0000-0000-0000-000000000000',
  email: '',
  date_range: { from: '2026-09-29T00:00:00Z', to: '2026-10-13T00:00:00Z' },
  summary: { total_sent: 0, total_replied: 0, total_received: 0, average_daily: 0, reply_rate: 0, target_progress: 0, days_active: 0 },
  daily_stats: [],
}
const ALLOWANCE = { used: 0, allowance: null, remaining: null, basis: 'unlimited', sends_per_mailbox: 1, paid: true }

describe('warmbly client', () => {
  it('normalises the base URL to /v1', () => {
    expect(apiBase('https://ovh-hermes.taila95862.ts.net')).toBe('https://ovh-hermes.taila95862.ts.net/v1')
    expect(apiBase('https://x.example/v1/')).toBe('https://x.example/v1')
  })

  it('sends GET with the Bearer key and nothing else', async () => {
    const { impl, calls } = fakeFetch({ '/v1/me': { body: ME } })
    const c = new WarmblyClient({ baseUrl: 'https://w.example', apiKey: 'wmbly_test', fetchImpl: impl })
    await c.me()
    expect(calls).toHaveLength(1)
    expect(calls[0].init.method).toBe('GET')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer wmbly_test')
    expect(calls[0].init.body).toBeUndefined()
  })

  it("turns Warmbly's error body into words with the status", async () => {
    const { impl } = fakeFetch({ '/v1/me': { status: 401, body: { error: 'Unauthorized', message: 'Invalid or expired token.', code: 'unauthorized' } } })
    const c = new WarmblyClient({ baseUrl: 'https://w.example', apiKey: 'bad', fetchImpl: impl })
    await expect(c.me()).rejects.toMatchObject({ status: 401, message: 'Warmbly answered 401: Invalid or expired token.' })
    await expect(c.me()).rejects.toBeInstanceOf(WarmblyError)
  })

  it('refuses an empty key', () => {
    expect(() => new WarmblyClient({ baseUrl: 'https://w.example', apiKey: '  ' })).toThrow(WarmblyError)
  })
})

describe('warmbly snapshot', () => {
  const now = new Date('2026-10-13T16:40:00Z')

  it('an org with nothing connected reads as real zeros, not missing data', async () => {
    const { impl, calls } = fakeFetch({
      '/v1/me': { body: ME },
      '/v1/emails': { body: EMPTY_PAGE },
      '/v1/campaigns': { body: EMPTY_PAGE },
      '/v1/analytics/warmup': { body: WARMUP_EMPTY },
      '/v1/emails/allowance': { body: ALLOWANCE },
    })
    const snap = await readWarmblySnapshot(new WarmblyClient({ baseUrl: 'https://w.example', apiKey: 'k', fetchImpl: impl }), now)
    expect(snap.me).toEqual({ ok: true, value: { organization: 'TapDash', scopes: ME.scopes } })
    expect(snap.mailboxes).toEqual({ ok: true, value: { total: 0, rows: [], truncated: false } })
    expect(snap.campaigns).toEqual({ ok: true, value: { total: 0, rows: [], truncated: false } })
    expect(snap.warmup).toEqual({ ok: true, value: { from: '2026-09-29', to: '2026-10-13', sent: 0, replied: 0, replyRate: 0, daysActive: 0 } })
    expect(snap.allowance).toEqual({ ok: true, value: { used: 0, allowance: null, remaining: null, basis: 'unlimited' } })
    // Warmbly requires both dates on the warm-up read.
    const w = calls.find((c) => c.url.includes('/analytics/warmup'))!
    expect(new URL(w.url).searchParams.get('from')).toBe('2026-09-29')
    expect(new URL(w.url).searchParams.get('to')).toBe('2026-10-13')
    expect(calls.every((c) => c.init.method === 'GET')).toBe(true)
  })

  it('one failing endpoint leaves the others readable', async () => {
    const { impl } = fakeFetch({
      '/v1/me': { body: ME },
      '/v1/emails': { body: EMPTY_PAGE },
      '/v1/campaigns': { status: 403, body: { error: 'Forbidden', message: 'insufficient API key permissions' } },
      '/v1/analytics/warmup': { body: WARMUP_EMPTY },
      '/v1/emails/allowance': { body: ALLOWANCE },
    })
    const snap = await readWarmblySnapshot(new WarmblyClient({ baseUrl: 'https://w.example', apiKey: 'k', fetchImpl: impl }), now)
    expect(snap.campaigns).toEqual({ ok: false, status: 403, error: 'Warmbly answered 403: insufficient API key permissions' })
    expect(snap.mailboxes.ok).toBe(true)
  })

  it('maps a mailbox row from its real column names, keeping unreported fields null', () => {
    const row = mailboxRow({
      id: 'mb1',
      email: 'yaakov@tapdash.co',
      provider: 'google',
      status: 'active',
      warmup: true,
      warmup_paused_at: null,
      auth_spf: 'pass',
      auth_dkim: false,
      send_lifecycle: 'ramping',
      risk_band: 'low',
    })
    expect(row).toMatchObject({ email: 'yaakov@tapdash.co', provider: 'google', warmup: 'on', spf: 'pass', dkim: 'fail', dmarc: null, sending: 'ramping', risk: 'low' })
    expect(mailboxRow({ id: 'mb2', warmup: true, warmup_paused_at: '2026-10-12T00:00:00Z' }).warmup).toBe('paused')
    expect(mailboxRow({ id: 'mb3', warmup: false }).warmup).toBe('off')
    // No warmup key at all: not reported, never "off".
    expect(mailboxRow({ id: 'mb4' }).warmup).toBeNull()
  })

  it('maps a campaign row and surfaces a tripped guardrail', () => {
    expect(campaignRow({ id: 'c1', name: 'Jewelers Q4', status: 'active', daily_limit: 40 })).toEqual({ id: 'c1', name: 'Jewelers Q4', status: 'active', dailyLimit: 40, guardrail: null })
    expect(campaignRow({ id: 'c2', guardrail_tripped_at: '2026-10-12T00:00:00Z', guardrail_reason: 'bounce rate over 3%' }).guardrail).toBe('bounce rate over 3%')
  })
})
