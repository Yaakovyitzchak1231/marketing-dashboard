// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const confirm = vi.fn(async (_i: { includeTimeline: boolean }) => ({ ok: true as const, total_deleted: 1, total_timeline_deleted: 0 }))
vi.mock('@/app/actions/retention-sweep', () => ({
  previewRetentionSweepAction: async () => ({
    ok: true,
    categories: [{ event_category: 'email_opened', keep_days: 90, touches: 1, timeline_events: 2 }],
    total_touches: 1,
    total_timeline_events: 2,
  }),
  confirmRetentionSweepAction: (i: { includeTimeline: boolean }) => confirm(i),
}))
import { RunSweepButton } from '@/components/settings/RunSweepButton'

afterEach(() => cleanup())

describe('RunSweepButton: review, then confirm; timeline kept unless ticked', () => {
  it('lists what will be deleted and confirms with timeline history OFF by default', async () => {
    render(<RunSweepButton />)
    fireEvent.click(screen.getByText('Review sweep'))
    await waitFor(() => screen.getByTestId('sweep-review'))
    expect(screen.getByText(/email_opened older than 90 days: 1 event/)).toBeTruthy()
    const box = screen.getByRole('checkbox') as HTMLInputElement
    expect(box.checked).toBe(false)
    fireEvent.click(screen.getByText('Confirm and delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ includeTimeline: false }))
  })

  it('passes the opt-in when the owner ticks it', async () => {
    confirm.mockClear()
    render(<RunSweepButton />)
    fireEvent.click(screen.getByText('Review sweep'))
    await waitFor(() => screen.getByTestId('sweep-review'))
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByText(/plus 2 timeline entries/)).toBeTruthy()
    fireEvent.click(screen.getByText('Confirm and delete'))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ includeTimeline: true }))
  })
})
