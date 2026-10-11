// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const confirm = vi.fn(async (_i: { includeTimeline: boolean }) => ({ ok: true as const, total_deleted: 1, total_timeline_deleted: 2, recompute_queued: ['score_refresh', 'traits_refresh'] }))
vi.mock('@/app/actions/retention-sweep', () => ({
  previewRetentionSweepAction: async () => ({
    ok: true,
    categories: [{ event_category: 'email_opened', keep_days: 90, touches: 1, timeline_events: 2 }],
    total_touches: 1,
    total_timeline_events: 2,
    timeline_impact: {
      event_types: ['email_opened'],
      score_models: [{ id: 1, name: 'Engagement' }],
      traits: [{ key: 'opens_14d', label: 'Opens (14d)' }],
      segments: [],
      note: 'Score points already earned are kept.',
    },
  }),
  confirmRetentionSweepAction: (i: { includeTimeline: boolean }) => confirm(i),
}))
import { RunSweepButton } from '@/components/settings/RunSweepButton'

afterEach(() => cleanup())

describe('p2fu-c: RunSweepButton shows what deleting timeline history affects (finding 4)', () => {
  it('hides the impact until the owner ticks the box, then names models/traits/segments', async () => {
    render(<RunSweepButton />)
    fireEvent.click(screen.getByText('Review sweep'))
    await waitFor(() => screen.getByTestId('sweep-review'))
    expect(screen.queryByTestId('sweep-timeline-impact')).toBeNull()
    fireEvent.click(screen.getByRole('checkbox'))
    const panel = screen.getByTestId('sweep-timeline-impact')
    expect(panel.textContent).toMatch(/Score models: Engagement/)
    expect(panel.textContent).toMatch(/Traits: Opens \(14d\)/)
    expect(panel.textContent).toMatch(/Segments with event conditions: none/)
    fireEvent.click(screen.getByText('Confirm and delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ includeTimeline: true }))
    await waitFor(() => screen.getByText(/Recompute queued \(score_refresh, traits_refresh\)/))
  })
})
