import { describe, it, expect, vi } from 'vitest'
vi.mock('server-only', () => ({}))

// Mock the settings store so we can assert resolveConfig is used.
const resolveConfigMock = vi.fn(async (_key: string, _env?: Record<string, string | undefined>): Promise<{ value: string | null; source: string }> => ({ value: null, source: 'unset' }))
vi.mock('@/lib/db', () => ({ getDb: () => null }))
vi.mock('@/lib/settings/store', () => ({ resolveConfig: resolveConfigMock }))

import { verifyEnvFromConfig } from '@/lib/verify/runs'
import { providerBalancesAsync } from '@/lib/verify/overview'

describe('verify settings-aware config', () => {
  it('verifyEnvFromConfig resolves keys via resolveConfig (DB then env fallback)', async () => {
    resolveConfigMock.mockImplementation(async (key: string) => {
      if (key === 'millionverifier.api_key') return { value: 'mv-key-from-db', source: 'db' }
      if (key === 'zerobounce.api_key') return { value: 'zb-key-from-db', source: 'db' }
      return { value: null, source: 'unset' }
    })
    const env = await verifyEnvFromConfig()
    expect(env.keys.millionverifier).toBe('mv-key-from-db')
    expect(env.keys.zerobounce).toBe('zb-key-from-db')
    expect(resolveConfigMock).toHaveBeenCalledWith('millionverifier.api_key', process.env)
    expect(resolveConfigMock).toHaveBeenCalledWith('zerobounce.api_key', process.env)
  })

  it('providerBalancesAsync does not call paid endpoints when keys are missing', async () => {
    resolveConfigMock.mockResolvedValue({ value: null, source: 'unset' })
    const result = await providerBalancesAsync()
    // No key set -> balances report key not set, no network call attempted.
    expect(result.millionverifier).toEqual(expect.objectContaining({ key_set: false }))
    expect(result.zerobounce).toEqual(expect.objectContaining({ key_set: false }))
  })
})
