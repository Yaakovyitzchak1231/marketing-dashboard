// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * /verify shows spend, estimates and per-run results, and the /api/verify
 * reads need editor access. A viewer must not get the same numbers from the
 * page instead: they see one plain line and nothing is read from the database.
 */
const { getDb, listRuns } = vi.hoisted(() => ({ getDb: vi.fn(() => ({})), listRuns: vi.fn(async () => []) }))
vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/db', () => ({ getDb }))
vi.mock('@/lib/auth/session', () => ({ currentRole: vi.fn() }))
vi.mock('@/lib/verify/runs', async (orig) => ({ ...(await orig<typeof import('@/lib/verify/runs')>()), listRuns, getRun: vi.fn(async () => null) }))
vi.mock('@/lib/verify/overview', async (orig) => ({
  ...(await orig<typeof import('@/lib/verify/overview')>()),
  providerBalancesAsync: vi.fn(async () => ({
    millionverifier: { key_set: false, credits: null, error: null },
    zerobounce: { key_set: false, credits: null, error: null },
  })),
  verificationCounts: vi.fn(async () => ({ total: 0, by_status: { unverified: 0, valid: 0, invalid: 0, catch_all: 0, unknown: 0, risky: 0 } })),
}))

import { currentRole } from '@/lib/auth/session'
import VerifyPage from '@/app/verify/page'

afterEach(cleanup)

describe('/verify role gate', () => {
  it.each([['viewer'], [null]])('a %s sees the access note and nothing is read', async (role) => {
    vi.mocked(currentRole).mockResolvedValue(role as never)
    render(await VerifyPage({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText(/needs editor access/)).toBeTruthy()
    expect(screen.queryByText('Recent runs')).toBeNull()
    expect(screen.queryByText('Check leads')).toBeNull()
    expect(listRuns).not.toHaveBeenCalled()
  })

  it.each([['editor'], ['owner']])('an %s sees the screen', async (role) => {
    vi.mocked(currentRole).mockResolvedValue(role as never)
    render(await VerifyPage({ searchParams: Promise.resolve({}) }))
    expect(screen.getByText('Recent runs')).toBeTruthy()
    expect(screen.queryByText(/needs editor access/)).toBeNull()
  })
})
