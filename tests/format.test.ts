import { describe, it, expect } from 'vitest'
import {
  formatCount,
  formatRate,
  formatCurrency,
  formatDate,
  isUnavailable,
  UNAVAILABLE,
} from '@/lib/format'

// These are the project's central truth rules from AGENTS.md, expressed as
// executable assertions. A metric the API did not report must never reach the
// screen as a number -- not 0, not "0%", not a dash that reads as a value.

describe('isUnavailable', () => {
  it('treats null and undefined as unavailable', () => {
    expect(isUnavailable(null)).toBe(true)
    expect(isUnavailable(undefined)).toBe(true)
  })

  it('does NOT treat a real zero as unavailable', () => {
    // The distinction the whole project turns on: 0 is a measurement.
    expect(isUnavailable(0)).toBe(false)
    expect(isUnavailable(0.0)).toBe(false)
  })

  it('does not treat an empty string as unavailable', () => {
    expect(isUnavailable('')).toBe(false)
  })
})

describe('formatCount', () => {
  it('formats a real count with thousands separators', () => {
    expect(formatCount(31893)).toBe('31,893')
    expect(formatCount(0)).toBe('0')
    expect(formatCount(7)).toBe('7')
  })

  it('returns the unavailable marker for null -- never "0"', () => {
    expect(formatCount(null)).toBe(UNAVAILABLE)
    expect(formatCount(null)).not.toBe('0')
  })

  it('returns the unavailable marker for undefined', () => {
    expect(formatCount(undefined)).toBe(UNAVAILABLE)
  })

  it('does not coerce a null to a zero at any magnitude', () => {
    const thousand = formatCount(null)
    const million = formatCount(null)
    expect(thousand).toBe(million)
    expect(thousand).toBe(UNAVAILABLE)
  })
})

describe('formatRate', () => {
  it('formats a real rate as a percentage', () => {
    expect(formatRate(0.05)).toBe('5.0%')
    expect(formatRate(0)).toBe('0.0%')
    expect(formatRate(1)).toBe('100.0%')
  })

  it('returns the unavailable marker for null -- never "0.0%"', () => {
    // The exact bug this project exists to fix: open rate read 0.0% because
    // the API does not populate it. A null must never render as 0.0%.
    expect(formatRate(null)).toBe(UNAVAILABLE)
    expect(formatRate(null)).not.toBe('0.0%')
  })

  it('returns the unavailable marker for undefined', () => {
    expect(formatRate(undefined)).toBe(UNAVAILABLE)
  })
})

describe('formatCurrency', () => {
  it('formats a real currency value', () => {
    expect(formatCurrency(125000)).toBe('$125,000')
    expect(formatCurrency(0)).toBe('$0')
  })

  it('returns the unavailable marker for null', () => {
    expect(formatCurrency(null)).toBe(UNAVAILABLE)
  })
})

describe('formatDate', () => {
  it('formats an ISO date as a short human date', () => {
    expect(formatDate('2026-09-30')).toBe('Sep 30, 2026')
  })

  it('returns the unavailable marker for a missing date', () => {
    expect(formatDate(null)).toBe(UNAVAILABLE)
  })

  it('returns the unavailable marker for an unparseable date rather than Invalid Date', () => {
    expect(formatDate('not-a-date')).toBe(UNAVAILABLE)
  })
})
