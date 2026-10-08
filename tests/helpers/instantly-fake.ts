/**
 * A fake Instantly API v2 for tests: routes requests to the fixtures in
 * tests/fixtures/instantly (shaped like real, anonymised responses) and records
 * every call. Test-only; nothing in the app imports this.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const DIR = join(__dirname, '..', 'fixtures', 'instantly')
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(readFileSync(join(DIR, `${name}.json`), 'utf8')) as T
}

export const C1 = '11111111-1111-4111-8111-111111111111'
export const C2 = '22222222-2222-4222-8222-222222222222'
export const C3 = '33333333-3333-4333-8333-333333333333'

export interface Call {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  auth: string | null
}

export type Override = (call: Call) => Response | undefined

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

export function fakeInstantly(override?: Override) {
  const calls: Call[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const path = url.pathname.replace(/^\/api\/v2/, '')
    const headers = new Headers(init?.headers)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    const call: Call = { method: init?.method ?? 'GET', path, query: url.searchParams, body, auth: headers.get('authorization') }
    calls.push(call)
    const o = override?.(call)
    if (o) return o
    const q = url.searchParams
    switch (path) {
      case '/campaigns':
        return json(fixture(q.get('starting_after') ? 'campaigns_page2' : 'campaigns_page1'))
      case '/campaigns/analytics':
        return json(fixture(q.get('start_date') ? 'analytics_range' : 'analytics_alltime'))
      case '/campaigns/analytics/overview': {
        const id = q.get('id')
        if (id === C1) return json(fixture('overview_campaign_c1'))
        if (id === C2) return json(fixture('overview_campaign_c2'))
        if (id) return json({ message: 'not found' }, 404)
        return json(fixture(q.get('start_date') === '2026-09-09' || !q.get('start_date') ? 'overview_range' : 'overview_prev'))
      }
      case '/campaigns/analytics/daily':
        return json(fixture('daily_range'))
      case '/campaigns/analytics/steps':
        return json(fixture(q.get('campaign_id') === C1 ? 'steps_c1' : 'steps_c2'))
      case '/accounts':
        return json(fixture(q.get('starting_after') ? 'accounts_page2' : 'accounts_page1'))
      case '/accounts/analytics/daily': {
        const emails = (q.get('emails') ?? '').split(',').filter(Boolean)
        if (!emails.length) return json({ message: 'Analytics request is too large for this workspace.' }, 413)
        const s = q.get('start_date') ?? ''
        const e = q.get('end_date') ?? ''
        const rows = fixture<Array<{ date: string; email_account: string }>>('account_daily')
        return json(rows.filter((r) => emails.includes(r.email_account) && r.date >= s && r.date <= e))
      }
      case '/emails':
        return json(fixture(q.get('starting_after') ? 'threads_page2' : 'threads_page1'))
      case '/leads/list': {
        const contacts = ((body as { contacts?: string[] })?.contacts ?? []).map((x) => x.toLowerCase())
        const all = fixture<{ items: Array<{ email: string }> }>('leads_by_email')
        return json({ items: all.items.filter((l) => contacts.includes(l.email.toLowerCase())), next_starting_after: null })
      }
      default:
        return json({ message: `no route ${path}` }, 404)
    }
  }) as typeof fetch
  return { fetchImpl, calls }
}
