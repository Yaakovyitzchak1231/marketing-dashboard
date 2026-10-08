import { describe, expect, it } from 'vitest'
import { trendInsights } from '@/lib/insights/trends'
import { campaign, day, input, totals } from '../fixtures/insights/builders'

describe('reply / positive rate trends', () => {
  it('significant drop is a warning with both periods and the change', () => {
    const r = trendInsights(input({ totals: totals({ contacted: 1000, replied: 30 }), previous: totals({ contacted: 1000, replied: 60 }) }))
    const t = r.find((i) => i.id === 'trend-reply-down')!
    expect(t.severity).toBe('warning')
    expect(t.title).toBe('Reply rate down to 3% from 6%')
    expect(t.detail).toContain('The last 30 days: 30 of 1,000')
    expect(t.detail).toContain('The 30 days before: 60 of 1,000 (6%)')
    expect(t.detail).toContain('−3 pts (−50%)')
  })
  it('significant rise is a win; positive rate too', () => {
    const r = trendInsights(input({
      totals: totals({ contacted: 1000, replied: 80, positive: 40 }),
      previous: totals({ contacted: 1000, replied: 40, positive: 10 }),
    }))
    expect(r.find((i) => i.id === 'trend-reply-up')!.severity).toBe('win')
    expect(r.find((i) => i.id === 'trend-positive-up')!.title).toBe('Positive-reply rate up to 4% from 1%')
  })
  it('noise, small samples, nulls and no previous period are silent', () => {
    expect(trendInsights(input({ totals: totals({ contacted: 1000, replied: 50 }), previous: totals({ contacted: 1000, replied: 55 }) }))).toEqual([])
    expect(trendInsights(input({ totals: totals({ contacted: 99, replied: 1 }), previous: totals({ contacted: 1000, replied: 90 }) }))).toEqual([])
    expect(trendInsights(input({ totals: totals({ contacted: 1000, replied: null }), previous: totals({ contacted: 1000, replied: 90 }) }))).toEqual([])
    expect(trendInsights(input({ totals: totals({ contacted: 1000, replied: 10 }), previous: null }))).toEqual([])
  })
})

describe('volume drop', () => {
  it('fires when sends fall by half or more', () => {
    const r = trendInsights(input({ totals: totals({ sent: 800 }), previous: totals({ sent: 2100 }) }))
    const v = r.find((i) => i.id === 'trend-volume-down')!
    expect(v.title).toBe('Sending volume fell 61.9%')
    expect(v.detail).toBe('800 emails sent in the last 30 days vs 2,100 in the 30 days before.')
  })
  it('silent for smaller drops or small previous volume', () => {
    expect(trendInsights(input({ totals: totals({ sent: 1200 }), previous: totals({ sent: 2000 }) }))).toEqual([])
    expect(trendInsights(input({ totals: totals({ sent: 0 }), previous: totals({ sent: 150 }) }))).toEqual([])
  })
})

describe('sending stalled', () => {
  const days = (pairs: [string, number | null][]) => pairs.map(([d, s]) => day(d, s))
  it('3 finished days of zero after sending days; today excluded; critical with an active campaign', () => {
    const r = trendInsights(input({
      campaigns: [campaign('a', { status: 'active' })],
      daily: days([['2026-10-03', 120], ['2026-10-04', 140], ['2026-10-05', 0], ['2026-10-06', 0], ['2026-10-07', 0], ['2026-10-08', 0]]),
    }))
    const s = r.find((i) => i.id === 'sending-stalled')!
    expect(s.severity).toBe('critical')
    expect(s.title).toBe('No emails sent since Oct 4')
    expect(s.detail).toContain('3 days in a row')
    expect(s.detail).toContain('sent 140')
  })
  it('a weekend (2 days) never fires; today with 0 so far never counts', () => {
    expect(trendInsights(input({ daily: days([['2026-10-02', 100], ['2026-10-03', 0], ['2026-10-04', 0], ['2026-10-05', 90]]) }))).toEqual([])
    expect(trendInsights(input({ daily: days([['2026-10-05', 100], ['2026-10-06', 0], ['2026-10-07', 0], ['2026-10-08', 0]]) }))).toEqual([])
  })
  it('null days break the streak (unknown is not zero); never-sent range is silent', () => {
    expect(trendInsights(input({ daily: days([['2026-10-03', 100], ['2026-10-04', 0], ['2026-10-05', null], ['2026-10-06', 0], ['2026-10-07', 0]]) }))).toEqual([])
    expect(trendInsights(input({ daily: days([['2026-10-03', 0], ['2026-10-04', 0], ['2026-10-05', 0], ['2026-10-06', 0]]) }))).toEqual([])
  })
  it('warning when no campaign is active', () => {
    const r = trendInsights(input({ daily: days([['2026-10-03', 100], ['2026-10-04', 0], ['2026-10-05', 0], ['2026-10-06', 0], ['2026-10-07', 0]]) }))
    expect(r.find((i) => i.id === 'sending-stalled')!.severity).toBe('warning')
  })
})
