import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import {
  readSendControls,
  resolveLeadTimezone,
  resolveLeadTimezoneDetail,
  sendAllowed,
  validateSendControls,
  type SendControls,
} from '@/lib/journeys/send-controls'

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
    expect(sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: QUIET },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T12:01:00Z'),
      reason: 'quiet hours',
    })
  })

  it('with a window too, the hold runs to the window opening, not just the end of quiet hours', () => {
    // Same moment. Quiet ends 12:00Z (08:00 EDT) but the weekday window only opens 09:00 EDT = 13:00Z.
    expect(sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: QUIET, send_window: WINDOW },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T13:01:00Z'),
      reason: 'send window',
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
      companyTimezone: 'America/New_York',
      controls: { launch_at: '2026-10-14T16:00:00.000Z' },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T16:01:00.000Z'),
      reason: 'before launch',
    })
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { active_until: '2026-10-14T12:00:00Z' },
    })).toEqual({ allow: false, until: null, reason: 'past active-until' })
  })

  it('when quiet hours and the window both block, returns the first instant everything allows', () => {
    // Wednesday 08:00 EDT = 12:00Z. Quiet 21:00-10:00 ends 14:00Z; window opens 09:00 EDT = 13:00Z.
    // The window alone would free the send at 13:01Z, but quiet hours still hold until 14:01Z.
    const decision = sendAllowed(at('2026-10-14T12:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: {
        quiet_hours: { start: '21:00', end: '10:00' },
        send_window: WINDOW,
      },
    })
    expect(decision).toEqual({
      allow: false,
      until: at('2026-10-14T14:01:00Z'),
      reason: 'quiet hours',
    })
    // And the instant it names really is allowed.
    expect(sendAllowed(at('2026-10-14T14:01:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: { start: '21:00', end: '10:00' }, send_window: WINDOW },
    })).toEqual({ allow: true })
  })

  it('when the window is the later hold, it names the window', () => {
    // Friday 22:00 EDT = Saturday 02:00Z. Quiet ends Saturday 08:00 EDT (12:01Z) but the window waits for Monday 09:00 EDT.
    expect(sendAllowed(at('2026-10-17T02:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: QUIET, send_window: WINDOW },
    })).toEqual({
      allow: false,
      until: at('2026-10-19T13:01:00Z'),
      reason: 'send window',
    })
  })

  it('a launch hold that lands inside quiet hours keeps holding to the end of quiet hours', () => {
    // Launch Tuesday 22:00 EDT (Wed 02:00Z); 02:01Z is 22:01 EDT, quiet until 08:00 EDT = 12:00Z.
    expect(sendAllowed(at('2026-10-14T00:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: QUIET, launch_at: '2026-10-14T02:00:00Z' },
    })).toEqual({
      allow: false,
      until: at('2026-10-14T12:01:00Z'),
      reason: 'quiet hours',
    })
  })

  it('skips at once when the hold would end at or after active-until', () => {
    // 22:00Z = 18:00 EDT, in quiet 17:00-08:00. Quiet ends 08:00 EDT on Oct 31 (12:00Z), after active-until 00:00Z.
    expect(sendAllowed(at('2026-10-30T22:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: { start: '17:00', end: '08:00' }, active_until: '2026-10-31T00:00:00Z' },
    })).toEqual({ allow: false, until: null, reason: 'past active-until' })
    // A hold that ends before active-until is still a wait.
    expect(sendAllowed(at('2026-10-30T22:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: { start: '17:00', end: '08:00' }, active_until: '2026-11-02T00:00:00Z' },
    })).toMatchObject({ allow: false, reason: 'quiet hours', until: at('2026-10-31T12:01:00Z') })
  })

  it('falls back to workspace quiet hours when the journey sets none', () => {
    expect(sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { send_window: null },
      workspaceQuietHours: QUIET,
    })).toEqual({
      allow: false,
      until: at('2026-10-14T12:01:00Z'),
      reason: 'quiet hours',
    })
    // Unset workspace hours (blank strings) are absent, not malformed.
    expect(sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      workspaceQuietHours: { start: '', end: '' },
    })).toEqual({ allow: true })
  })

  it('a malformed quiet-hours clock holds the send instead of dropping the limit', () => {
    const d = sendAllowed(at('2026-10-14T01:30:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { quiet_hours: { start: 'nope', end: '08:00' } },
      workspaceQuietHours: QUIET,
    })
    expect(d).toMatchObject({ allow: false, reason: 'invalid send controls' })
  })
})

describe('stored workspace quiet hours that are bad are visible (plan 3.10)', () => {
  const NOW = at('2026-10-14T01:30:00Z') // Tuesday 21:30 EDT, inside the usual quiet window
  const ny = { companyTimezone: 'America/New_York' }

  it.each([
    ['only the start set', { start: '21:00', end: null }],
    ['only the end set', { start: '', end: '08:00' }],
    ['equal start and end', { start: '09:00', end: '09:00' }],
    ['a start that is not HH:MM', { start: '9pm', end: '08:00' }],
  ])('holds with "invalid workspace quiet hours", naming the settings keys, for %s', (_n, workspaceQuietHours) => {
    const d = sendAllowed(NOW, { ...ny, controls: {}, workspaceQuietHours })
    expect(d).toMatchObject({ allow: false, reason: 'invalid workspace quiet hours' })
    if (d.allow === false && 'errors' in d) {
      expect(d.errors.join(' ')).toMatch(/workspace\.quiet_hours_start/)
      expect(d.errors.join(' ')).toMatch(/workspace\.quiet_hours_end/)
      expect(d.until.getTime()).toBeGreaterThan(NOW.getTime())
    }
  })

  it('a journey with its own quiet hours does not read the workspace pair', () => {
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      ...ny,
      controls: { quiet_hours: QUIET },
      workspaceQuietHours: { start: '21:00', end: null },
    })).toEqual({ allow: true })
  })

  it('unset workspace hours (null, blank strings, or absent) are not a problem', () => {
    for (const w of [null, undefined, { start: null, end: null }, { start: '', end: '  ' }]) {
      expect(sendAllowed(at('2026-10-14T14:00:00Z'), { ...ny, controls: {}, workspaceQuietHours: w })).toEqual({ allow: true })
    }
  })

  it('a sound workspace pair still applies, with surrounding spaces tolerated', () => {
    expect(sendAllowed(NOW, { ...ny, workspaceQuietHours: { start: ' 21:00', end: '08:00 ' } })).toMatchObject({
      allow: false,
      reason: 'quiet hours',
    })
  })

  it('a bad send window outranks it in the reason, and both are listed', () => {
    const d = sendAllowed(NOW, { ...ny, controls: { send_window: { days: 'x' } }, workspaceQuietHours: { start: '21:00', end: null } })
    expect(d).toMatchObject({ allow: false, reason: 'invalid send window' })
    if (d.allow === false && 'errors' in d) expect(d.errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('malformed send controls fail closed (plan 3.10)', () => {
  const NOW = at('2026-10-17T15:00:00Z') // Saturday 11:00 EDT
  const ny = { companyTimezone: 'America/New_York' }

  it.each([
    ['days as a string', { days: '1,2,3', start: '09:00', end: '17:00' }],
    ['days as a number', { days: 5, start: '09:00', end: '17:00' }],
    ['days as an object', { days: { 0: 1 }, start: '09:00', end: '17:00' }],
    ['days missing', { start: '09:00', end: '17:00' }],
    ['days as numeric strings', { days: ['1', '2'], start: '09:00', end: '17:00' }],
    ['an empty days list', { days: [], start: '09:00', end: '17:00' }],
    ['a day out of range', { days: [1, 7], start: '09:00', end: '17:00' }],
    ['a start without a leading zero', { days: [1], start: '9:00', end: '17:00' }],
    ['an end that is not a time', { days: [1], start: '09:00', end: 'late' }],
    ['a zero-length window', { days: [1], start: '09:00', end: '09:00' }],
    ['a non-object window', 'weekdays'],
  ])('holds with "invalid send window" for %s, and does not throw', (_name, send_window) => {
    // Saturday 11:00 EDT: with a window of Mondays only, a malformed window must not read as "no limit".
    const d = sendAllowed(NOW, { ...ny, controls: { send_window } })
    expect(d).toMatchObject({ allow: false, reason: 'invalid send window' })
    if (d.allow === false && d.reason === 'invalid send window') {
      expect(d.until.getTime()).toBeGreaterThan(NOW.getTime())
      expect(d.errors.length).toBeGreaterThan(0)
    }
  })

  it('Saturday 11:00 EDT with {days:[1], start:"9:00", end:"17:00"} is a hold, not an allow', () => {
    const d = sendAllowed(NOW, { ...ny, controls: { send_window: { days: [1], start: '9:00', end: '17:00' } } })
    expect(d.allow).toBe(false)
    expect(d).toMatchObject({ reason: 'invalid send window' })
  })

  it('a valid Monday-only window still holds a Saturday until Monday', () => {
    expect(sendAllowed(NOW, { ...ny, controls: { send_window: { days: [1], start: '09:00', end: '17:00' } } })).toEqual({
      allow: false,
      until: at('2026-10-19T13:01:00Z'),
      reason: 'send window',
    })
  })

  it('holds for a malformed quiet-hours object, launch_at, active_until, or send_controls itself', () => {
    for (const controls of [
      { quiet_hours: 'night' },
      { quiet_hours: { start: '21:00' } },
      { launch_at: 'tomorrow' },
      { active_until: 12345 },
      'always',
      ['x'],
    ]) {
      expect(sendAllowed(NOW, { ...ny, controls })).toMatchObject({ allow: false, reason: 'invalid send controls' })
    }
  })

  it('treats null and undefined fields as absent, not malformed', () => {
    expect(sendAllowed(NOW, { ...ny, controls: null })).toEqual({ allow: true })
    expect(sendAllowed(NOW, { ...ny, controls: {} })).toEqual({ allow: true })
    expect(sendAllowed(NOW, {
      ...ny,
      controls: { quiet_hours: null, send_window: null, launch_at: null, active_until: null, fallback_timezone: null },
    })).toEqual({ allow: true })
  })

  it('past active-until is still a skip even if another field is malformed', () => {
    expect(sendAllowed(NOW, {
      ...ny,
      controls: { active_until: '2026-10-01T00:00:00Z', send_window: { days: 'x' } },
    })).toEqual({ allow: false, until: null, reason: 'past active-until' })
  })

  it('readSendControls hands back the stored value uninterpreted', () => {
    expect(readSendControls({ send_controls: { send_window: { days: '1,2,3' } } })).toEqual({ send_window: { days: '1,2,3' } })
    expect(readSendControls({})).toBeUndefined()
    expect(readSendControls(null)).toBeUndefined()
    expect(readSendControls({ send_controls: 'junk' })).toBe('junk')
    // ...and sendAllowed on that value does not throw.
    expect(sendAllowed(NOW, { ...ny, controls: readSendControls({ send_controls: 'junk' }) })).toMatchObject({
      allow: false,
      reason: 'invalid send controls',
    })
  })
})

describe('validateSendControls (save-time, plan 3.10)', () => {
  it('accepts sound config and absent config', () => {
    expect(validateSendControls(undefined)).toEqual([])
    expect(validateSendControls(null)).toEqual([])
    expect(validateSendControls({
      quiet_hours: QUIET,
      fallback_timezone: 'America/Chicago',
      send_window: WINDOW,
      launch_at: '2026-10-14T13:00:00Z',
      active_until: '2026-11-01T00:00:00-04:00',
    })).toEqual([])
  })

  it('names every problem', () => {
    const errors = validateSendControls({
      quiet_hours: { start: '9pm', end: '08:00' },
      send_window: { days: 'mon', start: '9:00', end: '17:00' },
      fallback_timezone: 'Mars/Olympus',
      launch_at: 'soon',
    })
    expect(errors.join('\n')).toMatch(/quiet_hours\.start/)
    expect(errors.join('\n')).toMatch(/send_window\.days/)
    expect(errors.join('\n')).toMatch(/send_window\.start/)
    expect(errors.join('\n')).toMatch(/fallback_timezone/)
    expect(errors.join('\n')).toMatch(/launch_at/)
  })

  it('requires an explicit offset on launch_at and active_until', () => {
    for (const bad of ['2026-10-14T13:00:00', '2026-10-14T13:00', '2026-10-14', '2026-10-14 13:00:00Z']) {
      expect(validateSendControls({ launch_at: bad })).toHaveLength(1)
      expect(validateSendControls({ active_until: bad })).toHaveLength(1)
    }
    for (const good of ['2026-10-14T13:00:00Z', '2026-10-14T13:00Z', '2026-10-14T09:00:00-04:00', '2026-10-14T13:00:00.500+0000']) {
      expect(validateSendControls({ launch_at: good })).toEqual([])
    }
  })

  it('an offset-less launch_at stored before this check fails closed at send time instead of using the server zone', () => {
    expect(sendAllowed(at('2026-10-14T14:00:00Z'), {
      companyTimezone: 'America/New_York',
      controls: { launch_at: '2026-10-14T16:00:00' },
    })).toMatchObject({ allow: false, reason: 'invalid send controls' })
  })
})

describe('journey_upsert rejects bad send controls (plan 3.10)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('rejects a malformed send window and an offset-less launch_at with a clear 400', async () => {
    await expect(runOp(db, 'owner', 'journey_upsert', {
      name: 'Bad window',
      settings: { send_controls: { send_window: { days: '1,2,3', start: '9:00', end: '17:00' } } },
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/send_controls is invalid.*send_window/) })
    await expect(runOp(db, 'owner', 'journey_upsert', {
      name: 'Bad launch',
      settings: { send_controls: { launch_at: '2026-10-14T13:00:00' } },
    })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/launch_at must be an ISO date-time with an explicit offset/) })
  })

  it('saves sound send controls, and settings without any', async () => {
    const good = await runOp(db, 'owner', 'journey_upsert', {
      name: 'Good controls',
      settings: { send_controls: { quiet_hours: QUIET, send_window: WINDOW, launch_at: '2026-10-14T13:00:00Z' } },
    }) as { id: number; settings: { send_controls: unknown } }
    expect(good.settings.send_controls).toMatchObject({ send_window: WINDOW })
    await expect(runOp(db, 'owner', 'journey_upsert', { name: 'No controls', settings: { other: 1 } })).resolves.toMatchObject({ name: 'No controls' })
    // Editing an existing journey is checked too.
    await expect(runOp(db, 'owner', 'journey_upsert', {
      id: good.id,
      name: 'Good controls',
      settings: { send_controls: { send_window: { days: [], start: '09:00', end: '17:00' } } },
    })).rejects.toMatchObject({ status: 400 })
  })
})

describe('daylight saving and midnight (plan 3.10)', () => {
  const ny = { companyTimezone: 'America/New_York' }

  it('spring-forward: a window opening inside the skipped hour resolves to after the gap, past now', () => {
    // New York Sunday 2026-03-08: 02:00 EST jumps to 03:00 EDT at 07:00Z. 06:31Z is 01:31 EST.
    const now = at('2026-03-08T06:31:00Z')
    const d = sendAllowed(now, { ...ny, controls: { send_window: { days: [0], start: '02:30', end: '04:00' } } })
    expect(d).toMatchObject({ allow: false, reason: 'send window' })
    if (d.allow === false && d.until) {
      expect(d.until.getTime()).toBeGreaterThan(now.getTime())
      expect(d.until).toEqual(at('2026-03-08T07:01:00Z'))
    }
    expect(sendAllowed(at('2026-03-08T07:01:00Z'), { ...ny, controls: { send_window: { days: [0], start: '02:30', end: '04:00' } } })).toEqual({ allow: true })
  })

  it('spring-forward: quiet hours ending inside the skipped hour also resolve past the gap', () => {
    const now = at('2026-03-08T06:31:00Z')
    expect(sendAllowed(now, { ...ny, controls: { quiet_hours: { start: '22:00', end: '02:30' } } })).toEqual({
      allow: false,
      until: at('2026-03-08T07:01:00Z'),
      reason: 'quiet hours',
    })
  })

  it('a hold is always strictly after now, minute by minute across both DST changes', () => {
    const controls: SendControls[] = [
      { send_window: { days: [0, 1, 2, 3, 4, 5, 6], start: '02:30', end: '04:00' } },
      { send_window: { days: [0, 6], start: '01:30', end: '02:30' } },
      { quiet_hours: { start: '01:00', end: '03:00' } },
      { quiet_hours: { start: '22:00', end: '02:30' }, send_window: { days: [0], start: '02:15', end: '05:00' } },
    ]
    for (const zone of ['America/New_York', 'Europe/London', 'Australia/Lord_Howe']) {
      for (const start of [Date.parse('2026-03-07T00:00:00Z'), Date.parse('2026-10-31T12:00:00Z')]) {
        for (let m = 0; m < 3 * 24 * 60; m += 7) {
          const now = new Date(start + m * 60_000)
          for (const c of controls) {
            const d = sendAllowed(now, { companyTimezone: zone, controls: c })
            if (d.allow === false && d.until) expect(d.until.getTime()).toBeGreaterThan(now.getTime())
          }
        }
      }
    }
  })

  it('autumn: an ambiguous boundary resolves to its first occurrence', () => {
    // New York Sunday 2026-11-01: 01:00-02:00 happens twice. Quiet 22:00-01:30 ends the first 01:30 EDT = 05:30Z.
    expect(sendAllowed(at('2026-11-01T04:00:00Z'), { ...ny, controls: { quiet_hours: { start: '22:00', end: '01:30' } } })).toEqual({
      allow: false,
      until: at('2026-11-01T05:31:00Z'),
      reason: 'quiet hours',
    })
  })

  it('a window that wraps midnight is open after midnight on the next day', () => {
    const controls: SendControls = { send_window: { days: [5], start: '22:00', end: '02:00' } }
    // Friday 2026-10-16 23:00 EDT: open.
    expect(sendAllowed(at('2026-10-17T03:00:00Z'), { ...ny, controls })).toEqual({ allow: true })
    // Saturday 01:00 EDT (05:00Z): still the Friday window.
    expect(sendAllowed(at('2026-10-17T05:00:00Z'), { ...ny, controls })).toEqual({ allow: true })
    // Saturday 03:00 EDT (07:00Z): closed; next opens Friday 22:00 EDT = Saturday Oct 24 02:00Z.
    expect(sendAllowed(at('2026-10-17T07:00:00Z'), { ...ny, controls })).toEqual({
      allow: false,
      until: at('2026-10-24T02:01:00Z'),
      reason: 'send window',
    })
    // Sunday 01:00 EDT is not covered: Saturday is not a window day.
    expect(sendAllowed(at('2026-10-18T05:00:00Z'), { ...ny, controls })).toMatchObject({ allow: false, reason: 'send window' })
  })

  it('reads local midnight as 00:00, not 24:00', () => {
    // Wednesday 2026-10-14 00:30 EDT = 04:30Z.
    expect(sendAllowed(at('2026-10-14T04:30:00Z'), { ...ny, controls: { send_window: { days: [3], start: '00:00', end: '06:00' } } })).toEqual({ allow: true })
  })
})

describe('timezone default is visible (plan 3.10)', () => {
  const NOW = at('2026-10-14T14:00:00Z')

  it('flags a decision that used the America/New_York house default', () => {
    expect(sendAllowed(NOW, {})).toEqual({ allow: true, timezone_defaulted: true })
    expect(sendAllowed(NOW, { contactTimezone: 'Nope/Nope', companyTimezone: 'also bad', controls: { fallback_timezone: 'zzz' } })).toEqual({
      allow: true,
      timezone_defaulted: true,
    })
    expect(sendAllowed(NOW, { controls: { launch_at: '2026-10-14T16:00:00Z' } })).toMatchObject({
      allow: false,
      reason: 'before launch',
      timezone_defaulted: true,
    })
  })

  it('does not flag a real zone, and still defaults to Eastern time', () => {
    expect(sendAllowed(NOW, { contactTimezone: 'America/Los_Angeles' })).toEqual({ allow: true })
    expect(resolveLeadTimezoneDetail({})).toEqual({ timezone: 'America/New_York', defaulted: true })
    expect(resolveLeadTimezoneDetail({ companyTimezone: 'America/Chicago' })).toEqual({ timezone: 'America/Chicago', defaulted: false })
    // Evaluated in Eastern time: 06:30 EDT is quiet (21:00-08:00).
    expect(sendAllowed(at('2026-10-14T10:30:00Z'), { controls: { quiet_hours: QUIET } })).toMatchObject({
      allow: false,
      reason: 'quiet hours',
      timezone_defaulted: true,
    })
  })

  it('never throws on junk zone values', () => {
    for (const tz of [123, {}, [], true, '../../etc', 'x'.repeat(200), '\u0000']) {
      expect(() => sendAllowed(NOW, {
        contactTimezone: tz as unknown as string,
        companyTimezone: tz as unknown as string,
        controls: { fallback_timezone: tz },
      })).not.toThrow()
    }
  })
})
