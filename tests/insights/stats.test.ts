import { describe, expect, it } from 'vitest'
import { days, median, num, pct, pts, rate, significant, twoProportionZ, wilson } from '@/lib/insights/stats'

describe('rate', () => {
  it('divides raw counts', () => expect(rate(10, 495)).toBeCloseTo(0.0202, 4))
  it('is null for null or zero denominators, never 0', () => {
    expect(rate(5, 0)).toBeNull()
    expect(rate(5, null)).toBeNull()
    expect(rate(null, 100)).toBeNull()
  })
  it('measured zero stays zero', () => expect(rate(0, 100)).toBe(0))
  it('rejects impossible rates above 100% (autoreply artefacts)', () => expect(rate(333, 100)).toBeNull())
})

describe('wilson', () => {
  it('keeps a 2-of-5 lucky streak below 40-of-1000 on the lower bound', () => {
    const small = wilson(2, 5)!
    const big = wilson(40, 1000)!
    expect(small.lower).toBeLessThan(0.15)
    expect(big.lower).toBeGreaterThan(0.029)
    expect(big.lower).toBeLessThan(0.031)
    // the small one's interval is huge: honest uncertainty
    expect(small.upper - small.lower).toBeGreaterThan(0.5)
  })
  it('0 of 150 has an upper bound near 2.5%', () => {
    expect(wilson(0, 150)!.upper).toBeCloseTo(0.0249, 3)
    expect(wilson(0, 150)!.lower).toBe(0)
  })
  it('is null when the rate is undefined', () => expect(wilson(1, 0)).toBeNull())
})

describe('twoProportionZ', () => {
  it('is positive when the first proportion is higher and significant for a real gap', () => {
    const z = twoProportionZ(60, 1000, 30, 1000)
    expect(z).toBeGreaterThan(1.96)
    expect(significant(z)).toBe(true)
  })
  it('is not significant for a small gap on small samples', () => {
    expect(significant(twoProportionZ(4, 100, 2, 100))).toBe(false)
  })
  it('is null with no variance', () => expect(twoProportionZ(0, 100, 0, 100)).toBeNull())
})

describe('formatting', () => {
  it('pct', () => {
    expect(pct(0.0412)).toBe('4.1%')
    expect(pct(0.0045)).toBe('0.45%')
    expect(pct(0)).toBe('0%')
    expect(pct(0.02)).toBe('2%')
    expect(pct(1)).toBe('100%')
  })
  it('pts is signed', () => {
    expect(pts(0.012)).toBe('+1.2 pts')
    expect(pts(-0.019)).toBe('−1.9 pts')
  })
  it('num uses grouping', () => expect(num(11746)).toBe('11,746'))
  it('days', () => {
    expect(days(0.3)).toBe('under a day')
    expect(days(1.9)).toBe('1 day')
    expect(days(3.2)).toBe('3 days')
  })
  it('median', () => {
    expect(median([5, 1, 3])).toBe(3)
    expect(median([4, 1, 3, 2])).toBe(2.5)
  })
})
