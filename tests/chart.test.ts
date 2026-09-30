import { describe, it, expect } from 'vitest'
import { CHART_GEOMETRY, scaleX, scaleY } from '@/lib/chart'

/**
 * Chart geometry. These live in lib/ rather than inside the component so the
 * "no numeric literals in the render path" test (AC3) has nothing to whitelist
 * -- a whitelisted number is a number someone can grow into a metric.
 */

describe('CHART_GEOMETRY', () => {
  it('declares a positive viewbox in both axes', () => {
    expect(CHART_GEOMETRY.width).toBeGreaterThan(0)
    expect(CHART_GEOMETRY.height).toBeGreaterThan(0)
  })
})

describe('scaleX', () => {
  it('puts a single point at the left edge rather than dividing by zero', () => {
    // A one-day "trend" is a real first-run state. A NaN here would blank the
    // chart entirely, which is how an empty history ends up looking like a bug.
    const x = scaleX(0, 1)
    expect(Number.isFinite(x)).toBe(true)
  })

  it('spans the full padded width when there are two or more points', () => {
    const total = scaleX(3, 4)
    expect(total).toBeGreaterThan(scaleX(0, 4))
  })
})

describe('scaleY', () => {
  it('centres a flat series instead of collapsing to the top edge', () => {
    // A constant series has min === max. Dividing by (max - min) gives NaN,
    // which renders as nothing -- an invisible chart for real data.
    const y = scaleY(5, 5, 5)
    expect(Number.isFinite(y)).toBe(true)
  })

  it('puts the maximum at the top of the padded area and the minimum at the bottom', () => {
    const top = scaleY(10, 0, 10)
    const bottom = scaleY(0, 0, 10)
    expect(top).toBeLessThan(bottom)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(bottom).toBeLessThanOrEqual(CHART_GEOMETRY.height)
  })
})
