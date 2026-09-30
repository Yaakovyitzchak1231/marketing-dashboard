import { describe, it, expect } from 'vitest'
import {
  MAX_PLAUSIBLE_RATE,
  rateIsPlausible,
  formatPercentagePoints,
  countIsZero,
} from '@/lib/format'

/**
 * These constants decide what the dashboard is willing to call a measurement.
 * They live in lib/ with a name and a reason rather than as literals buried in
 * a component, because a reviewer has to be able to see them and disagree.
 */

describe('MAX_PLAUSIBLE_RATE', () => {
  it('is exactly one -- a rate above 100% is not a rate', () => {
    expect(MAX_PLAUSIBLE_RATE).toBe(1)
  })
})

describe('rateIsPlausible', () => {
  it('accepts a real rate', () => {
    expect(rateIsPlausible(0.05)).toBe(true)
    expect(rateIsPlausible(0)).toBe(true)
    expect(rateIsPlausible(1)).toBe(true)
  })

  it('rejects the 333% and 450% autoresponder artefacts', () => {
    expect(rateIsPlausible(3.33)).toBe(false)
    expect(rateIsPlausible(4.5)).toBe(false)
  })

  it('rejects a missing rate for a reason that is not plausibility', () => {
    // A null is not implausible -- it is unreported. Callers must handle the
    // two cases separately or they will label an absence as a bad number.
    expect(rateIsPlausible(null)).toBe(true)
  })
})

describe('formatPercentagePoints', () => {
  it('converts a percentage-point value to a percentage', () => {
    // warmup_avg arrives as 86.4 meaning 86.4%. It is a unit conversion of a
    // reported number, not a second measurement.
    expect(formatPercentagePoints(86.4)).toBe('86.4%')
  })

  it('returns the unavailable marker for null rather than 0.0%', () => {
    expect(formatPercentagePoints(null)).toBe('—')
  })
})

describe('countIsZero', () => {
  it('is true only for a measured zero', () => {
    expect(countIsZero(0)).toBe(true)
    expect(countIsZero(3)).toBe(false)
  })

  it('is false for an unreported count, so zero is never assumed', () => {
    expect(countIsZero(null)).toBe(false)
  })
})
