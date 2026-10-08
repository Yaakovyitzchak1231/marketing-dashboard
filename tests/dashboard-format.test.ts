import { describe, expect, it } from 'vitest'
import { countDelta, formatCount, formatDay, formatPct, formatUpdated, rangeSpan, rateDelta } from '@/components/dashboard/format'
import { parseRange } from '@/components/dashboard/range'

describe('dashboard formatting', () => {
  it('formats rates with one decimal and never turns null into 0%', () => {
    expect(formatPct(0.014184)).toBe('1.4%')
    expect(formatPct(0)).toBe('0.0%')
    expect(formatPct(null)).toBe('—')
    expect(formatPct(undefined)).toBe('—')
    expect(formatPct(Number.NaN)).toBe('—')
  })

  it('formats counts with separators; null stays a dash', () => {
    expect(formatCount(31893)).toBe('31,893')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(null)).toBe('—')
  })

  it('count deltas are relative % and undefined from zero or unknown', () => {
    expect(countDelta(2618, 3140)).toEqual({ text: '-17%', tone: 'bad', direction: 'down' })
    expect(countDelta(120, 100)).toEqual({ text: '+20%', tone: 'good', direction: 'up' })
    expect(countDelta(5, 0)).toBeNull()
    expect(countDelta(null, 10)).toBeNull()
    expect(countDelta(10, null)).toBeNull()
  })

  it('rate deltas are percentage points, and lower bounce is good', () => {
    expect(rateDelta(0.055, 0.04)).toEqual({ text: '+1.5 pts', tone: 'good', direction: 'up' })
    expect(rateDelta(0.0023, 0.0035, false)).toEqual({ text: '-0.1 pts', tone: 'good', direction: 'down' })
    expect(rateDelta(0.03, 0.02, false)?.tone).toBe('bad')
    expect(rateDelta(0.02, 0.02)?.direction).toBe('flat')
    expect(rateDelta(null, 0.02)).toBeNull()
  })

  it('formats days without timezone drift and range spans', () => {
    expect(formatDay('2026-10-08')).toBe('Oct 8')
    expect(rangeSpan('2026-09-09', '2026-10-08')).toBe('Sep 9 – Oct 8')
    expect(rangeSpan(null, '2026-10-08')).toBe('All time to Oct 8')
  })

  it('formats the freshness time in the dashboard timezone', () => {
    expect(formatUpdated('2026-10-08T16:10:00Z', 'America/New_York')).toMatch(/Oct 8, 12:10\s?PM EDT/)
    expect(formatUpdated('nope', 'America/New_York')).toBe('—')
  })

  it('parses ?range= safely', () => {
    expect(parseRange('7d')).toBe('7d')
    expect(parseRange('all')).toBe('all')
    expect(parseRange(['90d', '7d'])).toBe('90d')
    expect(parseRange('365d')).toBe('30d')
    expect(parseRange(undefined)).toBe('30d')
  })
})
