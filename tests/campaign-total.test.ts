import { describe, it, expect } from 'vitest'
import {
  CAMPAIGN_ROW_LIMIT,
  verifyCampaignTotal,
} from '@/lib/campaign-total'

/**
 * The unit of `total`.
 *
 * A count that describes joined `daily_metrics` rows instead of campaigns is
 * not a small error. `daily_metrics` holds one row per campaign per reported
 * day, so over a 7-day window the same query that should answer "148
 * campaigns" can answer "1,036 rows" -- and the dashboard would print
 * "Showing 100 of 1,036 campaigns" for a portfolio of 148. That is a fabricated
 * figure on screen, which is the one failure this project does not accept.
 *
 * These tests pin the refusal. Each one states WHY the input is rejected, so a
 * later change that widens what is published has to argue with a reason rather
 * than with a bare expectation.
 */
describe('verifyCampaignTotal', () => {
  it('publishes a count the two measurements agree on', () => {
    // 148 match the window, 200 exist in total. The window is a subset, so a
    // campaign count of 148 is consistent and is what the UI will show.
    expect(verifyCampaignTotal(148, 200, 100)).toBe(148)
  })

  it('publishes a count equal to the portfolio total', () => {
    // Every campaign matches the window. Still consistent.
    expect(verifyCampaignTotal(200, 200, 100)).toBe(200)
  })

  it('refuses a count larger than the whole portfolio', () => {
    // THE falsification. A campaign count can never exceed the count of all
    // campaigns, so a larger number is measuring something else -- almost
    // certainly joined metric rows. This is the case that would otherwise put a
    // number in the wrong unit on screen.
    expect(verifyCampaignTotal(1036, 200, 100)).toBeNull()
  })

  it('refuses a count smaller than the rows actually returned', () => {
    // A population of N cannot yield more than N rows. If it did, one of the
    // two queries is measuring something other than what was asked.
    expect(verifyCampaignTotal(0, 200, 1)).toBeNull()
    expect(verifyCampaignTotal(5, 200, 10)).toBeNull()
  })

  it('keeps zero, which is a measurement and not an absence', () => {
    // The counterweight to every guard above. `Number.isFinite` is not a falsy
    // check and must not become one, and neither is the portfolio comparison:
    // zero campaigns in the window is a result the source reported, and it is
    // consistent with a portfolio of 200.
    expect(verifyCampaignTotal(0, 200, 0)).toBe(0)
  })

  it('keeps a zero portfolio total', () => {
    // Nothing exists at all. Consistent with a windowed count of 0, and the
    // reader deserves to be told "0 campaigns", not "we could not count".
    expect(verifyCampaignTotal(0, 0, 0)).toBe(0)
  })

  it('refuses NaN, which is what an uncountable set arrives as', () => {
    // supabase-js derives `count` with `parseInt(contentRange[1])`, so a
    // `Content-Range: */*` header -- which PostgREST sends when it will not
    // count -- yields NaN. NaN is NOT nullish, so `count ?? null` would pass it
    // straight through and only the JSON serializer would save us. A
    // truthfulness guarantee that rests on the serializer is backwards.
    expect(verifyCampaignTotal(NaN, 200, 100)).toBeNull()
    expect(verifyCampaignTotal(148, NaN, 100)).toBeNull()
  })

  it('refuses Infinity on either side', () => {
    // Including as the PORTFOLIO count: an infinite baseline would falsify
    // everything, which is not a check, it is the absence of one. A bound that
    // cannot be trusted establishes nothing.
    expect(verifyCampaignTotal(Infinity, 200, 100)).toBeNull()
    expect(verifyCampaignTotal(148, Infinity, 100)).toBeNull()
  })

  it('refuses when either measurement is absent', () => {
    // Half a cross-check establishes nothing.
    expect(verifyCampaignTotal(null, 200, 100)).toBeNull()
    expect(verifyCampaignTotal(148, null, 100)).toBeNull()
    expect(verifyCampaignTotal(undefined as unknown as number, 200, 100)).toBeNull()
  })

  it('never returns a number smaller than what it was given as loaded rows', () => {
    // Property check across the shapes that matter, rather than three hand-picked
    // examples, so a refactor that reorders the guards cannot slip one through.
    const cases: [number | null, number | null, number][] = [
      [0, 0, 0],
      [1, 1, 1],
      [148, 200, 100],
      [100, 100, 100],
      [100, 99, 100],
      [5000, 5000, 100],
      [99, 5000, 100],
    ]
    for (const [windowed, portfolio, loaded] of cases) {
      const result = verifyCampaignTotal(windowed, portfolio, loaded)
      if (result !== null) {
        expect(result).toBeGreaterThanOrEqual(loaded)
        expect(result).toBeLessThanOrEqual(portfolio as number)
      }
    }
  })
})

describe('CAMPAIGN_ROW_LIMIT', () => {
  it('is a number, so the cap can be compared against a loaded row count', () => {
    // The component compares `loaded >= rowLimit` to decide whether truncation
    // happened even when no count came back. That comparison is meaningless if
    // this is not a real number, and `null` would silently disable the one
    // completeness signal that does not depend on trusting a count.
    expect(typeof CAMPAIGN_ROW_LIMIT).toBe('number')
    expect(Number.isFinite(CAMPAIGN_ROW_LIMIT)).toBe(true)
    expect(CAMPAIGN_ROW_LIMIT).toBeGreaterThan(0)
  })
})