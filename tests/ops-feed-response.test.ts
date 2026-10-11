import { describe, expect, it, vi } from 'vitest'
import type { Db } from '@/lib/db/types'
const { fetchFeed, dispatch, kick, db } = vi.hoisted(() => ({
  fetchFeed: vi.fn().mockResolvedValue([]), dispatch: vi.fn(), kick: vi.fn(),
  db: { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), tx: vi.fn() },
}))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/notify/deliver', () => ({ feed: fetchFeed, ackDeliveries: vi.fn(), dispatchDue: dispatch }))
vi.mock('@/lib/notify/kick', () => ({ kickDelivery: kick }))
vi.mock('@/lib/ops/gate', () => ({ opsGate: async () => ({ ok: true, agent: 'tab', db }) }))
import { runOp } from '@/lib/ops/dispatch'
import { GET } from '@/app/api/ops/[[...path]]/route'
import { NextRequest } from 'next/server'

describe('agent feed latency isolation', () => {
  it('does not run unrelated push deliveries before returning stored events', async () => {
    expect(await runOp(db as Db, 'tab', 'feed', {})).toEqual([])
    expect(fetchFeed).toHaveBeenCalledWith(db, 'tab', { after_id: null, limit: undefined })
    expect(dispatch).not.toHaveBeenCalled()
  })
  it('GET feed schedules the retry kick after reading rather than awaiting external delivery', async () => {
    const response = await GET(new NextRequest('https://dashboard.example/api/ops/feed'), { params: Promise.resolve({ path: ['feed'] }) })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, op: 'feed', data: [] })
    expect(kick).toHaveBeenCalledWith(db)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
