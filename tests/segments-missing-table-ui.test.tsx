// @vitest-environment jsdom
import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => ({ query: vi.fn() }) }))
vi.mock('@/lib/segments/store', () => ({
  listSegments: vi.fn(async () => {
    // Real pg/PGlite errors carry SQLSTATE 42P01 for a missing table; the page
    // keys off the code, not the message (Instinct #86 finding 2).
    throw Object.assign(new Error('relation "lp.segments" does not exist'), { code: '42P01' })
  }),
}))
vi.mock('@/lib/campaigns/store', () => ({ listCampaigns: vi.fn(async () => []) }))
vi.mock('@/lib/segments/presets', () => ({ listPresets: vi.fn(() => []) }))

import SegmentsPage from '@/app/segments/page'

describe('Segments list page: honest empty state before migration 0024 runs', () => {
  it('shows "Needs migration 0024" instead of crashing when lp.segments does not exist yet', async () => {
    render(await SegmentsPage())
    expect(screen.getByText(/Needs migration 0024/)).toBeInTheDocument()
    expect(screen.getByText(/runs on the next production deploy/)).toBeInTheDocument()
  })
})
