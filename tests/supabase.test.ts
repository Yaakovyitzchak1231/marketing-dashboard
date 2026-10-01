import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * `lib/supabase.ts` deliberately builds the browser client LAZILY.
 *
 * Constructing `createBrowserClient` at module scope made `next build` fail
 * whenever the public env vars were absent, because the build imports
 * app/login/page.tsx in a context that never serves a request. The client is
 * therefore created inside getSupabase() on first use, and a misconfigured
 * deploy raises an actionable error at that point instead of crashing the
 * build.
 *
 * These tests assert that contract: importing the module must always succeed;
 * the configuration error surfaces on first USE, not on import.
 */
describe('supabase client', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('initializes successfully with valid config', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'some-anon-key')

    const { getSupabase } = await import('../lib/supabase')
    const client = getSupabase()

    expect(client).toBeDefined()
    expect(typeof client.from).toBe('function')
    expect(typeof client.auth).toBe('object')
  })

  it('imports without throwing even when both env vars are missing', async () => {
    // The build must survive a missing public env: this import is the exact
    // path that used to crash `next build`.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    await expect(import('../lib/supabase')).resolves.toBeDefined()
  })

  it('throws an actionable error on first use when env vars are missing', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const { getSupabase } = await import('../lib/supabase')
    expect(() => getSupabase()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set/,
    )
  })

  it('throws on first use when only URL is provided', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    const { getSupabase } = await import('../lib/supabase')
    expect(() => getSupabase()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set/,
    )
  })

  it('throws on first use when only KEY is provided', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'some-anon-key')

    const { getSupabase } = await import('../lib/supabase')
    expect(() => getSupabase()).toThrow(
      /NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must both be set/,
    )
  })

  it('caches the client across calls', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'some-anon-key')

    const { getSupabase } = await import('../lib/supabase')
    expect(getSupabase()).toBe(getSupabase())
  })
})
