import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const KEY_B64 = Buffer.alloc(32, 3).toString('base64')

describe('settings ops (via the shared ops dispatcher)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    process.env.SETTINGS_KEY = KEY_B64
  })
  afterAll(async () => {
    await db.close()
  })

  it('list_settings returns every group, secrets carry no value field at all', async () => {
    const groups = (await runOp(db, 'owner', 'list_settings', {})) as { group: string; items: Record<string, unknown>[] }[]
    expect(groups.map((g) => g.group)).toEqual(expect.arrayContaining(['Workspace', 'Sending', 'Verification', 'AI', 'Google', 'Webhooks']))
    const sending = groups.find((g) => g.group === 'Sending')!
    const instantlyKey = sending.items.find((i) => i.key === 'instantly.api_key')!
    expect(instantlyKey.secret).toBe(true)
    expect('value' in instantlyKey).toBe(false)
    expect(instantlyKey.set).toBe(false)
  })

  it('get_setting returns a non-secret value and is refused for a secret key', async () => {
    await runOp(db, 'owner', 'put_setting', { key: 'workspace.timezone', value: 'America/Los_Angeles' })
    expect(await runOp(db, 'tab', 'get_setting', { key: 'workspace.timezone' })).toEqual({ key: 'workspace.timezone', value: 'America/Los_Angeles' })
    await expect(runOp(db, 'tab', 'get_setting', { key: 'instantly.api_key' })).rejects.toThrow(/is a secret/)
    await expect(runOp(db, 'tab', 'get_setting', { key: 'nope.not.real' })).rejects.toMatchObject({ status: 404 })
  })

  it('put_setting refuses an agent (only a person may write); owner can', async () => {
    await expect(runOp(db, 'tab', 'put_setting', { key: 'workspace.date_format', value: 'DD/MM/YYYY' })).rejects.toThrow(OpsError)
    await runOp(db, 'owner', 'put_setting', { key: 'workspace.date_format', value: 'DD/MM/YYYY' })
    expect(await runOp(db, 'owner', 'get_setting', { key: 'workspace.date_format' })).toEqual({ key: 'workspace.date_format', value: 'DD/MM/YYYY' })
  })

  it('put_setting validates and reports a clear error for a bad value', async () => {
    await expect(runOp(db, 'owner', 'put_setting', { key: 'workspace.timezone', value: 'Not/Real' })).rejects.toThrow(/not a timezone/)
  })

  it('secret_status never returns the secret value, only set/last4/updated fields', async () => {
    const before = (await runOp(db, 'tab', 'secret_status', { key: 'millionverifier.api_key' })) as Record<string, unknown>
    expect(before).toEqual({ key: 'millionverifier.api_key', set: false, last4: null, updated_at: null, updated_by: null })
    // Agents reach secret_status (reading set/last4 is fine); writing a secret stays owner-only and has no op at all.
    expect(Object.prototype.hasOwnProperty.call((await import('@/lib/settings/ops')).SETTINGS_OPS, 'put_secret')).toBe(false)
  })

  it('an unknown op is still a clean 404 (dispatcher-level, sanity check our table merged in)', async () => {
    await expect(runOp(db, 'owner', 'definitely_not_an_op', {})).rejects.toMatchObject({ status: 404 })
  })
})
