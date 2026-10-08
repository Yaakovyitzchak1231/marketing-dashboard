import { execSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('server-only', () => ({}))

import { loadSampleData } from '@/components/dashboard/sample'

describe('sample data is dev-only', () => {
  it('returns nothing unless DASHBOARD_SAMPLE=1', async () => {
    expect(await loadSampleData({ NODE_ENV: 'development' })).toBeNull()
    expect(await loadSampleData({ NODE_ENV: 'development', DASHBOARD_SAMPLE: 'true' })).toBeNull()
  })

  it('returns nothing in production even with the flag set', async () => {
    expect(await loadSampleData({ NODE_ENV: 'production', DASHBOARD_SAMPLE: '1' })).toBeNull()
  })

  it('loads the fixture in development with the flag', async () => {
    const data = await loadSampleData({ NODE_ENV: 'development', DASHBOARD_SAMPLE: '1' })
    expect(data?.configured).toBe(true)
    expect(data?.campaigns.length).toBeGreaterThan(0)
  })

  it('the fixture is internally consistent: rates recomputed from its own counts', async () => {
    const data = JSON.parse(readFileSync(join(process.cwd(), 'tests/fixtures/dashboard.sample.json'), 'utf8'))
    const { counts, rates } = data.totals
    expect(rates.replyRate).toBeCloseTo(counts.replied / counts.contacted, 10)
    expect(rates.bounceRate).toBeCloseTo(counts.sent ? counts.bounced / counts.sent : 0, 10)
    const dailySent = data.daily.reduce((s: number, d: { sent: number | null }) => s + (d.sent as number), 0)
    expect(dailySent).toBe(counts.sent)
    const campaignSent = data.campaigns.reduce((s: number, c: { counts: { sent: number } }) => s + c.counts.sent, 0)
    expect(campaignSent).toBe(counts.sent)
  })

  it('no app or component file imports the fixture directly', () => {
    const hits = execSync('grep -rlF "dashboard.sample.json" app components || true', { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
    expect(hits).toEqual(['components/dashboard/sample.ts'])
  })
})
