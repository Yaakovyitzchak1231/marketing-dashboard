import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

const { holder, dispatch } = vi.hoisted(() => ({ holder: { db: null as unknown }, dispatch: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('@/lib/notify/deliver', () => ({ dispatchDue: dispatch }))
import { GET } from '@/app/api/ops/deliveries/dispatch/route'
import { pauseAll, resumeAll } from '@/lib/ops/pause'

let db: Awaited<ReturnType<typeof createTestDb>>
const scheduler = 'test-scheduler-credential-not-a-real-secret'
const agent = 'test-agent-credential-not-a-real-secret'
const request = (credential?: string) => new Request('https://dashboard.example/api/ops/deliveries/dispatch', {
  headers: credential ? { Authorization: `Bearer ${credential}` } : {},
})
beforeAll(async () => { db = await createTestDb() })
afterAll(async () => { await db.close() })
beforeEach(() => {
  holder.db = db
  vi.stubEnv('CRON_SECRET', scheduler)
  vi.stubEnv('OPS_AGENT_TOKENS', `system:${agent}`)
  dispatch.mockReset().mockResolvedValue({ picked: 0, sent: 0, delivered: 0, held: 0, retrying: 0, failed: 0 })
})

describe('scheduled delivery safety net', () => {
  it('rejects missing, incorrect and agent credentials, including a system actor token', async () => {
    for (const credential of [undefined, 'wrong', agent, 'mdk_invalid']) {
      expect((await GET(request(credential))).status).toBe(401)
    }
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('fails closed when the scheduler credential is unset', async () => {
    vi.stubEnv('CRON_SECRET', '')
    expect((await GET(request(scheduler))).status).toBe(401)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('runs one bounded dispatch and returns measured counts, without cache', async () => {
    const response = await GET(request(scheduler))
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toMatchObject({ ok: true, result: { picked: 0 } })
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith(db)
  })
  it('honors the global agent pause', async () => {
    await pauseAll(db, 'owner')
    try {
      expect((await GET(request(scheduler))).status).toBe(423)
      expect(dispatch).not.toHaveBeenCalled()
    } finally { await resumeAll(db, 'owner') }
  })
  it('returns unavailable rather than fabricated delivery success without a database', async () => {
    holder.db = null
    expect((await GET(request(scheduler))).status).toBe(503)
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('does not leak database errors in the response', async () => {
    dispatch.mockRejectedValue(new Error('sensitive connection details'))
    const response = await GET(request(scheduler))
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('sensitive connection details')
  })
})
