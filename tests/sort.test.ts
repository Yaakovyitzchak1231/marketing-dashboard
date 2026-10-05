import { describe, it, expect } from 'vitest'
import { compareByMetric, compareByName } from '@/lib/sort'

type Row = { id: string; value: number | null; rate: number | null }

const row = (id: string, value: number | null = null, rate: number | null = null): Row =>
  ({ id, value, rate })

/**
 * The one rule these tests hold the line on: an unreported figure is
 * absent, not small. It sinks below every reported value in BOTH
 * directions, so toggling the direction cannot promote "not reported"
 * to the top of the list.
 */
describe('compareByMetric', () => {
  it('sinks an unreported value below every reported value, ascending', () => {
    const reported = row('a', 5)
    const unreported = row('b', null)
    expect(compareByMetric(unreported, reported, 'value', 'asc', (r) => r.id)).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(compareByMetric(reported, unreported, 'value', 'asc', (r) => r.id)).toBe(
      Number.NEGATIVE_INFINITY,
    )
  })

  it('sinks an unreported value below every reported value, descending', () => {
    // The bug: `-Infinity` for a missing value, negated by the
    // descending pass, floated every unknown row to the top.
    const reported = row('a', 5)
    const unreported = row('b', null)
    expect(compareByMetric(unreported, reported, 'value', 'desc', (r) => r.id)).toBe(
      Number.POSITIVE_INFINITY,
    )
    expect(compareByMetric(reported, unreported, 'value', 'desc', (r) => r.id)).toBe(
      Number.NEGATIVE_INFINITY,
    )
  })

  it('breaks ties between two unreported rows by name, reproducibly', () => {
    const left = row('alpha', null)
    const right = row('beta', null)
    expect(compareByMetric(left, right, 'value', 'asc', (r) => r.id)).toBeLessThan(0)
    expect(compareByMetric(left, right, 'value', 'desc', (r) => r.id)).toBeLessThan(0)
  })

  it('orders reported rows by their value and reverses with the direction', () => {
    const low = row('a', 1)
    const high = row('b', 9)
    expect(compareByMetric(low, high, 'value', 'asc', (r) => r.id)).toBeLessThan(0)
    expect(compareByMetric(low, high, 'value', 'desc', (r) => r.id)).toBeGreaterThan(0)
  })

  it('rejects a non-number the way it rejects a missing one', () => {
    // NaN is the other way a "figure" can arrive that is not a
    // figure. Ranking it would put it in the middle of the list
    // somewhere, which is worse than sinking it.
    const nan = row('a', NaN)
    const reported = row('b', 3)
    expect(compareByMetric(nan, reported, 'value', 'asc', (r) => r.id)).toBe(
      Number.POSITIVE_INFINITY,
    )
  })
})

describe('compareByName', () => {
  it('orders by name ascending', () => {
    expect(compareByName(row('a'), row('b'), 'asc', (r) => r.id)).toBeLessThan(0)
    expect(compareByName(row('b'), row('a'), 'asc', (r) => r.id)).toBeGreaterThan(0)
  })

  it('reverses for descending', () => {
    expect(compareByName(row('a'), row('b'), 'desc', (r) => r.id)).toBeGreaterThan(0)
    expect(compareByName(row('b'), row('a'), 'desc', (r) => r.id)).toBeLessThan(0)
  })
})
