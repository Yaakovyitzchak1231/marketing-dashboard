import { describe, expect, it } from 'vitest'
import { resolveLeadTimezone, sendAllowed, type SendControls } from '@/lib/journeys/send-controls'

const WEEKDAYS = [1, 2, 3, 4, 5]
const QUIET = { start: '21:00', end: '08:00' }
const WINDOW = { days: WEEKDAYS, start: '09:00', end: '17:00' }

function at(iso: string): Date {
  return new Date(iso)
}

describe('lead timezone (plan 3.10)', () => {
  it('prefers the contact zone over the company zone', () => {
    expect(resolveLeadTimezone({
      contactTimezone: 'America/Los_Angeles',
      companyTimezone: 'America/New_York',
    })).toBe('America/Los_Angeles')
  })

  it('skips a blank or invalid zone and uses the company, then the fallback, then New York', () => {
    expect(resolveLeadTimezone({
      contactTimezone: '  ',
      companyTimezone: 'America/Chicago',
    })).toBe('America/Chicago')
    expect(resolveLeadTimezone({
      contactTimezone: 'Nope/Nope',
      companyTimezone: 'Not/AZone',
      fallbackTimezone: 'America/Denver',
    })).toBe('America/Denver')
    expect(resolveLeadTimezone({
      contactTimezone: 'Nope/Nope',
      fallbackTimezone: 'also-bad',
    })).toBe('America/New_York')
  })
})

describe('sendAllowed (plan 3.10)', () => {
  const open: SendControls = {
    quiet_hours: QUIET,
    send_window: WINDOW,
    launch_at: '2026-10-01T00:00:00Z',
    active_until: '2026-11-01T00:00:00Z',
  }

  it('allows a weekday morning in the lead zone', () => {
    // Wednesday 14:00Z = 10:00 EDT.
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: open,
    })).toEqual({ allow: true })
  })

  it('uses the contact zone, so New York can be open while Los Angeles is still quiet', () => {
    // 12:30Z = 08:30 EDT (past 08:00) and 05:30 PDT (still quiet until 08:00 PDT = 15:00Z).
    const now = at('2026-10-14T12:30:00Z')
    const controls: SendControls = { quiet_hours: QUIET }
    expect(sendAllowed(now, { companyTimezone: 'America/New_York', controls })).toEqual({ allow: true })
    expect(sendAllowed(now, {
      contactTimezone: 'America/Los_Angeles',
      companyTimezone: 'America/New_York',
      controls,
    })).toEqual({
      allow: false,
      until: at('2026-10-14T15:01:00Z'),
      reason: 'quiet hours',
    })
  })

  it('holds through overnight quiet hours until one minute after they end', () => {
    // Tuesday 21:30 EDT = Wednesday 01:30Z. Quiet ends Wednesday 08:00 EDT = 12:00Z.
    const decision = sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: QUIET, send_window: WINDOW },
    })
    expect(decision).toEqual({
      allow: false,
      until: at('2026-10-14T12:01:00Z'),
      reason: 'quiet hours',
    })
  })

  it('holds a Saturday until the next weekday window', () => {
    // Saturday 11:00 EDT = 15:00Z. Next open is Monday 09:00 EDT = 13:00Z.
    expect(sendAllowed(at('2026-10-17T15:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { send_window: WINDOW },
    })).toEqual({
      allow: false,
      until: at('2026-10-19T13:01:00Z'),
      reason: 'send window',
    })
  })

  it('holds until launch, and skips once active-until has passed', () => {
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      controls: { launch_at: '2026-10-14T16:00:00.000Z' },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T16:01:00.000Z'),
      reason: 'before launch',
    })
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      controls: { active_until: '2026-10-14T12:00:00Z' },
    })).toEqual({ allow: false, until: null, reason: 'past active-until' })
  })

  it('when quiet hours and the window both block, returns the sooner one', () => {
    // Wednesday 08:00 EDT = 12:00Z. Quiet 21:00-10:00 ends 14:00Z; window opens 09:00 EDT = 13:00Z.
    expect(sendAllowed(at('2026-10-14T12:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: {
        quiet_hours: { start: '21:00', end: '10:00' },
        send_window: WINDOW,
      },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T13:01:00Z'),
      reason: 'send window',
    })
  })

  it('falls back to workspace quiet hours, and ignores a bad clock', () => {
    expect(sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: { start: 'nope', end: '08:00' } },
      workspaceQuietHours: QUIET,
    })).toEqual({
      allow: false,
      until: at('2026-10-14T12:01:00Z'),
      reason: 'quiet hours',
    })
  })
})
