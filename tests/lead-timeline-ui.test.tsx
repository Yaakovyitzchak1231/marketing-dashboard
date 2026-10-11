import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeadTimeline, relativeTime } from '@/components/leads/LeadTimeline'
import type { LeadEventRow } from '@/lib/leads/detail'

describe('LeadTimeline (render)', () => {
  it('shows the empty state with no events', () => {
    render(<LeadTimeline events={[]} />)
    expect(screen.getByText('No events yet.')).toBeTruthy()
  })

  it('renders plain labels newest-first, with campaign name and relative time', () => {
    const now = new Date('2026-10-11T12:00:00Z')
    const events: LeadEventRow[] = [
      { id: 2, type: 'reply_received', type_label: 'Reply received', occurred_at: new Date('2026-10-11T11:30:00Z'), campaign_id: 1, campaign_name: 'Fees angle', source: 'instantly_webhook', props: {} },
      { id: 1, type: 'custom', type_label: 'Custom event', occurred_at: new Date('2026-10-11T10:00:00Z'), campaign_id: null, campaign_name: null, source: 'instantly_webhook', props: { instantly_type: 'lead_out_of_office' } },
    ]
    render(<LeadTimeline events={events} />)
    expect(screen.getByText('Reply received')).toBeTruthy()
    expect(screen.getByText('Fees angle')).toBeTruthy()
    expect(screen.getByText('lead out of office')).toBeTruthy()
    expect(relativeTime('2026-10-11T11:30:00Z', now)).toBe('30m ago')
    expect(relativeTime('2026-10-11T11:59:50Z', now)).toBe('just now')
    expect(relativeTime('2026-10-10T12:00:00Z', now)).toBe('1d ago')
  })
})
