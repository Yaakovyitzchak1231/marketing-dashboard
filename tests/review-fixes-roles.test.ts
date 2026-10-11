import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/navigation', () => ({ redirect: (u: string) => { throw new Error(`REDIRECT ${u}`) } }))
vi.mock('@/lib/db', () => ({ getDb: () => null }))
const role = { current: 'viewer' as 'viewer' | 'editor' | 'owner' | null }
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => role.current,
  currentEmail: async () => 'x@example.com',
  currentActorId: async () => 'owner',
}))

import { addFromSegmentAction } from '@/app/actions/campaigns'
import { POST as postSegment } from '@/app/api/leads/segments/route'
import { POST as postList } from '@/app/api/leads/lists/route'

const fd = () => new FormData()
// Every Phase 2 write path, with the lowest role allowed to use it.
// The Phase 2 write paths this branch gates. The other Phase 2 server actions are gated
// with actorFor() on the e2e-fixes branch (same rule; kept off this branch to avoid two PRs
// editing the same lines).
const writes: [string, 'editor' | 'owner', () => Promise<unknown>][] = [
  ['addFromSegmentAction', 'editor', () => addFromSegmentAction(fd())],
]

async function denied(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run()
    return false
  } catch (e) {
    return /needs (editor|owner) access|Not signed in/.test((e as Error).message)
  }
}

// Viktor's cross-PR finding: Phase 2 write paths acted as 'owner' with no role check.
describe('review fix: Phase 2 write paths check the role (requireRole)', () => {
  beforeEach(() => { role.current = 'viewer' })

  it.each(writes)('%s refuses a Viewer and a signed-out caller, and admits %s', async (_name, min, run) => {
    role.current = 'viewer'
    expect(await denied(run)).toBe(true)
    role.current = null
    expect(await denied(run)).toBe(true)
    role.current = min
    expect(await denied(run)).toBe(false)
    if (min === 'owner') {
      role.current = 'editor'
      expect(await denied(run)).toBe(true)
    }
  })

  it('POST /api/leads/segments and /api/leads/lists answer 403 to a Viewer', async () => {
    const req = () => new Request('http://x/api', { method: 'POST', body: JSON.stringify({ name: 'x' }) })
    expect((await postSegment(req())).status).toBe(403)
    expect((await postList(req())).status).toBe(403)
    role.current = 'editor'
    expect((await postSegment(req())).status).not.toBe(403)
  })
})
