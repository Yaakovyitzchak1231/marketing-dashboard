import { describe, it, expect, vi, beforeEach } from 'vitest'
import { rateFrom, openRateFrom, unsubRateFrom, MIN_SENDS_FOR_TRUST } from '@/lib/rates'

/**
 * Rate rules, tested against the actual numbers Instantly returns for
 * instantly_moline-parsec rather than invented fixtures. A rule that only
 * passes on round numbers is not tested.
 */
describe('rateFrom', () => {
  it('computes the account reply rate from raw counts', () => {
    // overview: 1,910 unique replies from 45,545 sends
    const r = rateFrom({
      numerator: 1910,
      denominator: 45545,
      denominatorSource: 'emails_sent',
    })
    expect(r.value).toBe(0.0419)
    expect(r.trusted).toBe(true)
    expect(r.reason).toBeNull()
  })

  it('suppresses the 450% IRS Penalty Back campaign', () => {
    // 9 unique replies from 2 sends. Arithmetically impossible.
    const r = rateFrom({
      numerator: 9,
      denominator: 2,
      denominatorSource: 'emails_sent',
    })
    expect(r.value).toBeNull()
    expect(r.trusted).toBe(false)
    expect(r.reason).toBe('numerator_exceeds_denominator')
  })

  it('suppresses the 333% PB Signups TEST campaign', () => {
    const r = rateFrom({
      numerator: 10,
      denominator: 3,
      denominatorSource: 'emails_sent',
    })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('numerator_exceeds_denominator')
  })

  it('computes PB Signups / Leads correctly', () => {
    // 1,357 from 31,893 = 4.2549%, rounds to 0.0425
    const r = rateFrom({
      numerator: 1357,
      denominator: 31893,
      denominatorSource: 'emails_sent',
    })
    expect(r.value).toBe(0.0425)
    expect(r.trusted).toBe(true)
  })

  it('trusts a campaign with a small but valid denominator', () => {
    // PB Partners: 26 replies from 281 sends = 9.25%
    const r = rateFrom({
      numerator: 26,
      denominator: 281,
      denominatorSource: 'emails_sent',
    })
    expect(r.trusted).toBe(true)
    expect(r.reason).toBeNull()
  })

  it('never returns a rate above 1.0 for any input', () => {
    // Exhaustive over every impossible ratio the API could produce.
    for (const num of [1, 9, 10, 26, 1357]) {
      for (const den of [1, 2, 3, 4, 10, 281, 2126]) {
        const r = rateFrom({ numerator: num, denominator: den, denominatorSource: 'x' })
        if (r.value !== null) {
          expect(r.value).toBeLessThanOrEqual(1)
        }
      }
    }
  })

  it('returns null when the numerator was not collected', () => {
    const r = rateFrom({ numerator: null, denominator: 45545, denominatorSource: 'emails_sent' })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('not_collected')
  })

  it('returns null when the denominator was not collected', () => {
    const r = rateFrom({ numerator: 1910, denominator: null, denominatorSource: 'emails_sent' })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('not_collected')
  })

  it('returns null on zero denominator rather than zero rate', () => {
    // "No sends yet" is not "0% reply rate".
    const r = rateFrom({ numerator: 0, denominator: 0, denominatorSource: 'emails_sent' })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('no_sends')
  })

  it('computes a genuine zero rate when the numerator is a real zero', () => {
    const r = rateFrom({ numerator: 0, denominator: 1000, denominatorSource: 'emails_sent' })
    expect(r.value).toBe(0)
    expect(r.trusted).toBe(true)
  })

  it('marks any row from a partial collection untrusted', () => {
    // A rate computed from a subset is still arithmetically valid but is not
    // a measurement of the campaign, so it must not be trusted.
    const r = rateFrom({
      numerator: 100,
      denominator: 1000,
      denominatorSource: 'emails_sent',
      partial: true,
    })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('collector_error')
  })

  it('surfaces the collector error stage as the reason', () => {
    const r = rateFrom({
      numerator: null,
      denominator: null,
      denominatorSource: 'emails_sent',
      errorReason: 'campaign:8ddf6580',
    })
    expect(r.value).toBeNull()
    expect(r.reason).toBe('campaign:8ddf6580')
  })

  it('records the denominator source for traceability', () => {
    const r = rateFrom({ numerator: 10, denominator: 100, denominatorSource: 'emails_sent' })
    expect(r.denominatorSource).toBe('emails_sent')
  })

  it('has a trust threshold that excludes nothing above it', () => {
    // PB Partners has the smallest valid denominator in the portfolio.
    const r = rateFrom({ numerator: 26, denominator: 281, denominatorSource: 'emails_sent' })
    expect(281).toBeGreaterThanOrEqual(MIN_SENDS_FOR_TRUST)
    expect(r.trusted).toBe(true)
  })
})

describe('open rate and unsubscribe', () => {
  it('returns null when Instantly did not report opens', () => {
    // Every campaign and the overview return open_count_unique = 0.
    const r = openRateFrom({ opensUnique: 0, reported: false, denominator: 45545 })
    expect(r).toBeNull()
  })

  it('computes an open rate when the API actually reported one', () => {
    const r = openRateFrom({ opensUnique: 5000, reported: true, denominator: 45545 })
    expect(r).toBeCloseTo(0.1098, 4)
  })

  it('does not suppress a genuine zero when reported', () => {
    // The distinction that matters: reported-but-zero is a measurement.
    const r = openRateFrom({ opensUnique: 0, reported: true, denominator: 45545 })
    expect(r).toBe(0)
  })

  it('returns null on zero denominator', () => {
    expect(openRateFrom({ opensUnique: 100, reported: true, denominator: 0 })).toBeNull()
  })

  it('suppresses an impossible open rate', () => {
    expect(openRateFrom({ opensUnique: 50000, reported: true, denominator: 45545 })).toBeNull()
  })

  it('returns null for unreported unsubscribe', () => {
    expect(unsubRateFrom({ unsubscribed: 0, reported: false, denominator: 45545 })).toBeNull()
  })

  it('computes an unsubscribe rate when reported', () => {
    const r = unsubRateFrom({ unsubscribed: 174, reported: true, denominator: 45545 })
    expect(r).toBeCloseTo(0.0038, 4)
  })
})
