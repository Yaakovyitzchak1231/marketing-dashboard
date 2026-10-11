import { describe, it, expect, vi, beforeEach } from 'vitest'
vi.mock('server-only', () => ({}))
vi.mock('next/headers', () => ({ cookies: async () => ({ getAll: () => [] }) }))
const user = { email: 'izzy@example.com' as string | null }
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser: async () => ({ data: { user: user.email ? { email: user.email } : null }, error: null }) } }),
}))
const dbState = { fail: false }
vi.mock('@/lib/db', () => ({
  getDb: () => ({
    query: async () => {
      if (dbState.fail) throw new Error('connection reset')
      return { rows: [] }
    },
  }),
}))
import { currentActorId } from '@/lib/auth/session'

// Hermes' review: currentActorId() fell back to 'owner' when it could not identify the
// signed-in person, so their change was written as the owner's. It must fail closed.
describe('review fix: currentActorId fails closed', () => {
  beforeEach(() => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://sb.example'
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon'
    process.env.ALLOWED_USER_EMAIL = 'owner@example.com'
    dbState.fail = false
    user.email = 'izzy@example.com'
  })

  it('never returns owner for an account it cannot find or when the lookup fails', async () => {
    await expect(currentActorId()).rejects.toThrow(/nothing was saved/)
    dbState.fail = true
    await expect(currentActorId()).rejects.toThrow(/nothing was saved/)
    user.email = null
    await expect(currentActorId()).rejects.toThrow(/Not signed in/)
  })

  it('still maps the env owner to owner', async () => {
    user.email = 'owner@example.com'
    expect(await currentActorId()).toBe('owner')
  })
})
