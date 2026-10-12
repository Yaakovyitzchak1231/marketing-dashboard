import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { getSetting, putQuietHours, putSetting, SettingsError } from '@/lib/settings/store'
import { quietHoursPairError } from '@/lib/settings/quiet-hours'
import { requiredRole } from '@/lib/ops/actor-role'

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
