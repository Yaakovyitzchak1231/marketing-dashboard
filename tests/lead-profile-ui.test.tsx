import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Milestones } from '@/components/leads/Milestones'
import { Reachability } from '@/components/leads/Reachability'

describe('Milestones (render)', () => {
  it('shows an empty note when nothing has happened yet', () => {
    render(<Milestones data={{ first_touch: null, first_open: null, first_reply: null, last_activity: null }} />)
    expect(screen.getByText('Nothing recorded yet.')).toBeTruthy()
  })

  it('shows "Not yet" per-milestone, and a date for the ones that happened', () => {
    render(
      <Milestones
        data={{
          first_touch: '2026-10-01T09:00:00.000Z',
          first_open: '2026-10-01T10:00:00.000Z',
          first_reply: null,
          last_activity: '2026-10-03T12:00:00.000Z',
        }}
      />,
    )
    expect(screen.getAllByText('Not yet')).toHaveLength(1)
    expect(screen.getByText('First touch')).toBeTruthy()
    expect(screen.getByText('First reply')).toBeTruthy()
  })
})

describe('Reachability (render)', () => {
  it('renders each item with its value, or "Not found"', () => {
    render(
      <Reachability
        items={[
          { key: 'verified_email', label: 'Verified email', value: 'owner@geogems.com', ok: true },
          { key: 'store_phone', label: 'Store phone', value: null, ok: false },
          { key: 'owner_phone', label: 'Owner phone', value: null, ok: false },
          { key: 'linkedin', label: 'LinkedIn', value: null, ok: false },
        ]}
      />,
    )
    expect(screen.getByText('owner@geogems.com')).toBeTruthy()
    expect(screen.getAllByText('Not found')).toHaveLength(3)
  })
})
