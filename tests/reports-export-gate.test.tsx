// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'

/**
 * The Reports page: a viewer has no dead "Download CSV" link (the route needs
 * editor access); they see one plain line. An editor and an owner see the link.
 */
vi.mock('server-only', () => ({}))
vi.mock('next/navigation', () => ({ redirect: vi.fn(), useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock('@/lib/auth/session', () => ({ currentRole: vi.fn() }))
vi.mock('@/app/actions/reports', () => ({ runSheetExportAction: vi.fn() }))
vi.mock('@/lib/export/lead-master', () => ({ recentExports: async () => [] }))
vi.mock('@/lib/reports/load', async (orig) => {
  const actual = await orig<typeof import('@/lib/reports/load')>()
  return {
    ...actual,
    loadReportInputs: async () => ({
      sample: false,
      db: {},
      dbError: false,
      pools: null,
      meta: new Map(),
      data: { campaigns: [], range: { timezone: 'America/New_York' } },
    }),
    rangeDays: () => 7,
  }
})

import { currentRole } from '@/lib/auth/session'
import ReportsPage from '@/app/reports/page'

afterEach(cleanup)

async function renderAs(role: 'viewer' | 'editor' | 'owner' | null) {
  vi.mocked(currentRole).mockResolvedValue(role)
  render(await ReportsPage({ searchParams: Promise.resolve({}) }))
}

describe('/reports CSV export', () => {
  it.each([['viewer'], [null]] as const)('a %s sees a plain line and no download link', async (role) => {
    await renderAs(role)
    expect(screen.getByText('CSV export needs editor access.')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Download CSV' })).toBeNull()
    expect(document.querySelector('a[href="/api/reports/lead-master"]')).toBeNull()
  })

  it.each([['editor'], ['owner']] as const)('an %s sees the Download CSV link', async (role) => {
    await renderAs(role)
    const link = screen.getByRole('link', { name: 'Download CSV' })
    expect(link.getAttribute('href')).toBe('/api/reports/lead-master')
    expect(screen.queryByText('CSV export needs editor access.')).toBeNull()
  })
})
