import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { addCompany, addContact } from './helpers/lead-fixtures'
import { counts } from './helpers/report-fixtures'

const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({ currentRole: async () => 'owner', currentActorId: async () => 'owner', currentEmail: async () => null }))
vi.mock('@/lib/reports/load', async () => {
  const { buildWeeklyReport } = await import('@/lib/reports/weekly')
  return {
    loadWeeklyReport: async () => ({
      sample: false,
      report: buildWeeklyReport({
        data: {
          generatedAt: '2026-10-08T12:00:00Z',
          range: { key: '7d', start: '2026-10-02', end: '2026-10-08', timezone: 'America/New_York' },
          configured: true,
          totals: { counts: counts({ sent: 500, contacted: 200, replied: 4 }), rates: {} as never },
          previous: null,
          daily: [],
          campaigns: [],
          accounts: [],
          repliedLeads: [],
          insights: [],
          errors: [],
        },
        meta: new Map(),
        pools: [],
        tasks: [],
        approvals: [],
        dbConfigured: true,
      }),
    }),
  }
})

import { GET as weeklyAgent } from '@/app/api/ops/reports/weekly/route'
import { GET as weeklyHuman } from '@/app/api/reports/weekly/route'
import { GET as exportGet, POST as exportPost } from '@/app/api/ops/export/lead-master/route'
import { GET as exportHuman } from '@/app/api/reports/lead-master/route'
import { isSelfAuthenticatingApi } from '@/middleware'

const TOKEN = 'tab-token-0123456789abcdefghij'
const req = (url: string, auth?: string, method = 'GET') => new Request(url, { method, headers: auth ? { authorization: `Bearer ${auth}` } : {} })

describe('weekly report API', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('agents need their own token', async () => {
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    expect((await weeklyAgent(req('http://x/api/ops/reports/weekly'))).status).toBe(401)
    expect((await weeklyAgent(req('http://x/api/ops/reports/weekly', 'wrong-token-0123456789abcdef'))).status).toBe(401)
    const ok = await weeklyAgent(req('http://x/api/ops/reports/weekly', TOKEN))
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(body.agent).toBe('tab')
    expect(body.report.thisWeek.sent).toBe(500)
    expect(body.report.thisWeek.meetings).toBeNull()
  })

  it('serves markdown on ?format=md', async () => {
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    const res = await weeklyAgent(req('http://x/api/ops/reports/weekly?format=md', TOKEN))
    expect(res.headers.get('content-type')).toMatch(/text\/markdown/)
    const md = await res.text()
    expect(md).toMatch(/\| Emails sent \| 500 \| no data \|/)
    expect(md).toMatch(/\| Meetings booked \| no data \|/)
    const human = await weeklyHuman(req('http://x/api/reports/weekly?format=md'))
    expect(await human.text()).toMatch(/^# Weekly one-pager/)
  })

  it('the agent routes authenticate themselves; the human routes stay behind the login', () => {
    expect(isSelfAuthenticatingApi('/api/ops/reports/weekly')).toBe(true)
    expect(isSelfAuthenticatingApi('/api/ops/export/lead-master')).toBe(true)
    expect(isSelfAuthenticatingApi('/api/reports/weekly')).toBe(false)
    expect(isSelfAuthenticatingApi('/api/reports/lead-master')).toBe(false)
  })
})

describe('Lead Master copy API', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
    const c = await addCompany(db, { name: 'Gem Co' })
    await addContact(db, c, 'owner@gem.com', 'valid')
  })
  afterAll(async () => {
    await db.close()
  })
  afterEach(() => vi.unstubAllEnvs())

  it('rejects callers without an agent token or the cron secret', async () => {
    holder.db = db
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    vi.stubEnv('CRON_SECRET', 'cron-secret-0123456789')
    expect((await exportGet(req('http://x/api/ops/export/lead-master'))).status).toBe(401)
    expect((await exportPost(req('http://x/api/ops/export/lead-master', 'nope-nope-nope-nope-nope', 'POST'))).status).toBe(401)
  })

  it('serves the CSV to an agent and to Vercel Cron', async () => {
    holder.db = db
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    vi.stubEnv('CRON_SECRET', 'cron-secret-0123456789')
    const a = await exportGet(req('http://x/api/ops/export/lead-master', TOKEN))
    expect(a.status).toBe(200)
    expect(await a.text()).toMatch(/^email,first_name[^]*\r\nowner@gem\.com,/)
    const c = await exportGet(req('http://x/api/ops/export/lead-master', 'cron-secret-0123456789'))
    expect(c.status).toBe(200)
  })

  it('the Sheet export says what is missing instead of pretending', async () => {
    holder.db = db
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    const r = await exportPost(req('http://x/api/ops/export/lead-master', TOKEN, 'POST'))
    expect(r.status).toBe(503)
    expect((await r.json()).error).toMatch(/LEAD_MASTER_SHEET_ID/)
  })

  it('503 with no database', async () => {
    holder.db = null
    vi.stubEnv('OPS_AGENT_TOKENS', `tab:${TOKEN}`)
    expect((await exportGet(req('http://x/api/ops/export/lead-master', TOKEN))).status).toBe(503)
    expect((await exportHuman()).status).toBe(503)
  })

  it('the human download is a CSV attachment', async () => {
    holder.db = db
    const r = await exportHuman()
    expect(r.headers.get('content-disposition')).toMatch(/attachment; filename="lead-master-copy-/)
  })
})
