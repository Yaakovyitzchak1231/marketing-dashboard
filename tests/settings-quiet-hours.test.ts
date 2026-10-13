import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { getSetting, putQuietHours, putSetting, SettingsError } from '@/lib/settings/store'
import { quietHoursPairError } from '@/lib/settings/quiet-hours'
import { requiredRole } from '@/lib/ops/actor-role'
import { sendAllowed } from '@/lib/journeys/send-controls'

const START = 'workspace.quiet_hours_start'
const END = 'workspace.quiet_hours_end'

describe('quietHoursPairError', () => {
  it('accepts both blank, or both set and different', () => {
    expect(quietHoursPairError(null, undefined)).toBeNull()
    expect(quietHoursPairError('', '  ')).toBeNull()
    expect(quietHoursPairError('21:00', '08:00')).toBeNull()
    expect(quietHoursPairError('08:00', '21:00')).toBeNull()
  })

  it('names the keys for a half-set pair, equal ends, or a bad clock', () => {
    for (const [a, b] of [['21:00', ''], [null, '08:00'], ['09:00', '09:00'], ['9pm', '08:00']] as const) {
      const msg = quietHoursPairError(a, b)
      expect(msg).toMatch(/workspace\.quiet_hours_start/)
      expect(msg).toMatch(/workspace\.quiet_hours_end/)
    }
  })
})

describe('saving quiet hours is validated as a pair (plan 3.10)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  it('put_setting on one key is refused while it would leave a half-set range, and nothing is written', async () => {
    await expect(putSetting(db, 'owner', START, '21:00')).rejects.toThrow(SettingsError)
    await expect(putSetting(db, 'owner', START, '21:00')).rejects.toThrow(/both a start and an end/)
    await expect(putSetting(db, 'owner', END, '08:00')).rejects.toThrow(/both a start and an end/)
    await expect(runOp(db, 'owner', 'put_setting', { key: START, value: '21:00' })).rejects.toMatchObject({ status: 400 })
    expect(await getSetting(db, START)).toBeNull()
    expect(await getSetting(db, END)).toBeNull()
  })

  it('put_quiet_hours saves both together, in one call, via the ops API', async () => {
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: '21:00', end: '08:00' })).resolves.toEqual({ start: '21:00', end: '08:00' })
    expect(await getSetting(db, START)).toBe('21:00')
    expect(await getSetting(db, END)).toBe('08:00')
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from lp.status_history where entity_type = 'setting' and entity_key in ($1, $2)`, [START, END],
    )
    expect(rows[0].n).toBe(2)
  })

  it('rejects equal ends, a missing end, and a bad clock without changing what is stored', async () => {
    await expect(putQuietHours(db, 'owner', '09:00', '09:00')).rejects.toThrow(/same time/)
    await expect(putQuietHours(db, 'owner', '09:00', '')).rejects.toThrow(/both a start and an end/)
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: '9pm', end: '08:00' })).rejects.toMatchObject({ status: 400 })
    expect(await getSetting(db, START)).toBe('21:00')
    expect(await getSetting(db, END)).toBe('08:00')
  })

  it('a single-key edit is allowed when the other end is set and the result differs, and refused when it would match', async () => {
    await putSetting(db, 'owner', START, '22:00')
    expect(await getSetting(db, START)).toBe('22:00')
    await expect(putSetting(db, 'owner', START, '08:00')).rejects.toThrow(/same time/)
    await expect(putSetting(db, 'owner', END, '22:00')).rejects.toThrow(/same time/)
    expect(await getSetting(db, START)).toBe('22:00')
    expect(await getSetting(db, END)).toBe('08:00')
  })

  it('only a person may write it, and the op needs an Owner key', async () => {
    await expect(putQuietHours(db, 'tab', '20:00', '07:00')).rejects.toThrow(/Only a person/)
    expect(requiredRole('put_quiet_hours')).toBe('owner')
  })
})

describe('clearing workspace quiet hours (both blank)', () => {
  let db: Awaited<ReturnType<typeof createTestDb>>
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => db.close())

  const history = async () => {
    const { rows } = await db.query<{ entity_key: string; old_value: string | null; new_value: string | null }>(
      `select entity_key, old_value, new_value from lp.status_history where entity_type = 'setting' and entity_key in ($1, $2) order by id`, [START, END],
    )
    return rows
  }
  const NOW = new Date('2026-10-14T01:30:00Z') // Tuesday 21:30 in New York, inside 21:00-08:00
  const workspace = async () => ({ start: await getSetting(db, START), end: await getSetting(db, END) })

  it('a set pair can be cleared: both read back as unset, each key audited old -> null, and the send gate sees no workspace quiet hours', async () => {
    await putQuietHours(db, 'owner', '21:00', '08:00')
    expect(sendAllowed(NOW, { companyTimezone: 'America/New_York', workspaceQuietHours: await workspace() })).toMatchObject({ allow: false, reason: 'quiet hours' })

    await expect(putQuietHours(db, 'owner', '', '')).resolves.toEqual({ start: '', end: '' })
    expect(await getSetting(db, START)).toBeNull()
    expect(await getSetting(db, END)).toBeNull()
    const rows = await history()
    expect(rows.slice(-2)).toEqual([
      { entity_key: START, old_value: '21:00', new_value: null },
      { entity_key: END, old_value: '08:00', new_value: null },
    ])
    expect(quietHoursPairError((await workspace()).start, (await workspace()).end)).toBeNull()
    expect(sendAllowed(NOW, { companyTimezone: 'America/New_York', workspaceQuietHours: await workspace() })).toEqual({ allow: true })
  })

  it('clearing again is a no-op that writes no audit rows, and the pair can be set again afterwards', async () => {
    const before = (await history()).length
    await putQuietHours(db, 'owner', '  ', '')
    expect((await history()).length).toBe(before)
    await putQuietHours(db, 'owner', '22:00', '06:00')
    expect(await workspace()).toEqual({ start: '22:00', end: '06:00' })
  })

  it('the put_quiet_hours op clears with both blank (or null), and refuses exactly one blank or missing args', async () => {
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: '', end: '08:00' })).rejects.toMatchObject({ status: 400 })
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: '21:00', end: null })).rejects.toMatchObject({ status: 400 })
    await expect(runOp(db, 'owner', 'put_quiet_hours', {})).rejects.toMatchObject({ status: 400 })
    expect(await workspace()).toEqual({ start: '22:00', end: '06:00' }) // none of the refusals touched it
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: '', end: '' })).resolves.toEqual({ start: '', end: '' })
    expect(await workspace()).toEqual({ start: null, end: null })
    await putQuietHours(db, 'owner', '22:00', '06:00')
    await expect(runOp(db, 'owner', 'put_quiet_hours', { start: null, end: null })).resolves.toEqual({ start: '', end: '' })
    expect(await workspace()).toEqual({ start: null, end: null })
  })

  it('clearing repairs a stored half-set pair, and an agent cannot clear', async () => {
    await db.query(`insert into lp.settings (key, value, updated_by) values ($1, '"21:00"'::jsonb, 'owner')`, [START])
    expect(quietHoursPairError(...Object.values(await workspace()) as [string | null, string | null])).toMatch(/only one is set/)
    await expect(putQuietHours(db, 'tab', '', '')).rejects.toThrow(/Only a person/)
    expect(await getSetting(db, START)).toBe('21:00')
    await putQuietHours(db, 'owner', '', '')
    expect(await workspace()).toEqual({ start: null, end: null })
  })

  it('a stored empty string (older data) still reads as unset to the gate and clears cleanly', async () => {
    await db.query(`insert into lp.settings (key, value, updated_by) values ($1, '""'::jsonb, 'owner'), ($2, '""'::jsonb, 'owner')`, [START, END])
    expect(sendAllowed(NOW, { companyTimezone: 'America/New_York', workspaceQuietHours: await workspace() })).toEqual({ allow: true })
    await putQuietHours(db, 'owner', '', '')
    expect(await workspace()).toEqual({ start: null, end: null })
  })
})
