import { describe, it, expect } from 'vitest'
import { dateTime, shortDate } from '@/components/leads/pills'

// Comment #66: the Leads table's "Updated" column shows the time of day, not just the date.
describe('leads table Updated label', () => {
  it('shows date and time in New York', () => {
    // 00:36 UTC on Oct 13 is 8:36 PM on Oct 12 in New York (EDT).
    expect(dateTime('2026-10-13T00:36:00Z').replace(/\s/g, ' ')).toBe('Oct 12, 8:36 PM')
    expect(shortDate('2026-10-13T00:36:00Z')).toBe('Oct 12')
  })
  it('keeps the dash for a missing value', () => {
    expect(dateTime(null)).toBe('—')
  })
})
