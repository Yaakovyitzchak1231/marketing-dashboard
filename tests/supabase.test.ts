import { describe, it, expect, vi, beforeEach } from 'vitest'

// We need to use vi.mock to inspect createBrowserClient calls.
// However, the previous test worked nicely. Let's make sure it's robust and mocks if needed.
// Actually, not mocking createBrowserClient is fine because it doesn't do a network request on init.
// Let's refine the test.

describe('supabase client', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllEnvs()
  })

  it('initializes successfully with valid config', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'some-anon-key')

    const { supabase } = await import('../lib/supabase')

    // We can just assert that the client has certain methods
    expect(supabase).toBeDefined()
    expect(typeof supabase.from).toBe('function')
    expect(typeof supabase.auth).toBe('object')
  })

  it('throws an error if environment variables are missing', async () => {
    // Vitest stubbing to empty strings simulates missing process.env values in some environments,
    // though literally undefined could be tested. We'll delete them entirely just to be safe.
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    await expect(import('../lib/supabase')).rejects.toThrow(
      /@supabase\/ssr: Your project's URL and API key are required to create a Supabase client!/
    )
  })

  it('throws an error if only URL is provided', async () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://example.supabase.co')
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

    await expect(import('../lib/supabase')).rejects.toThrow(
      /@supabase\/ssr: Your project's URL and API key are required to create a Supabase client!/
    )
  })

  it('throws an error if only KEY is provided', async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', 'some-anon-key')

    await expect(import('../lib/supabase')).rejects.toThrow(
      /@supabase\/ssr: Your project's URL and API key are required to create a Supabase client!/
    )
  })
})
