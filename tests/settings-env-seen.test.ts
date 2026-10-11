import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { fingerprintOf, recordEnvSecretsSeen } from '@/lib/settings/env-seen'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('recordEnvSecretsSeen (lp.env_secret_seen)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('records first-seen once per value, resets on change, stores only a fingerprint, returns only last 4', async () => {
    const value = 're_live_' + 'k'.repeat(30) + 'Q9z8'
    const env: Record<string, string | undefined> = { MAIL_API_KEY: value, AI_API_KEY: '   ', INSTANTLY_API_KEY: undefined }

    const first = await recordEnvSecretsSeen(db, ['MAIL_API_KEY', 'AI_API_KEY', 'INSTANTLY_API_KEY'], env)
    expect([...first.keys()]).toEqual(['MAIL_API_KEY']) // unset/blank vars are skipped
    const a = first.get('MAIL_API_KEY')!
    expect(a.last4).toBe('Q9z8')
    expect(a.firstSeenAt).toBeTruthy()
    expect(JSON.stringify(a)).not.toContain(value)

    const { rows } = await db.query<{ env_name: string; fingerprint: string }>('select env_name, fingerprint from lp.env_secret_seen')
    expect(rows).toEqual([{ env_name: 'MAIL_API_KEY', fingerprint: fingerprintOf(value) }])
    expect(rows[0].fingerprint).toHaveLength(16)
    expect(rows[0].fingerprint).not.toContain('Q9z8')

    // Same value later: first-seen does not move.
    await db.query(`update lp.env_secret_seen set first_seen_at = '2026-10-01T12:00:00Z'`)
    const again = await recordEnvSecretsSeen(db, ['MAIL_API_KEY'], env)
    expect(again.get('MAIL_API_KEY')!.firstSeenAt).toBe('2026-10-01T12:00:00.000Z')

    // Changed value: first-seen resets to now.
    const changed = await recordEnvSecretsSeen(db, ['MAIL_API_KEY'], { MAIL_API_KEY: value + 'NEW1' })
    expect(changed.get('MAIL_API_KEY')!.last4).toBe('NEW1')
    expect(new Date(changed.get('MAIL_API_KEY')!.firstSeenAt!).getTime()).toBeGreaterThan(Date.parse('2026-10-02T00:00:00Z'))
  })

  it('never throws when the table is missing: last 4 still, no time', async () => {
    const broken = { query: async () => { throw new Error('relation "lp.env_secret_seen" does not exist') } }
    const r = await recordEnvSecretsSeen(broken as never, ['X_KEY'], { X_KEY: 'abcdefghijklmnop' })
    expect(r.get('X_KEY')).toEqual({ envName: 'X_KEY', last4: 'mnop', firstSeenAt: null })
  })
})
