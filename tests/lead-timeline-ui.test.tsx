import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { LeadTimeline, relativeTime, filterEvents } from '@/components/leads/LeadTimeline'
import type { LeadEventRow } from '@/lib/leads/detail'

describe('LeadTimeline (render)', () => {
  it('shows the empty state with no events', () => {
    render(<LeadTimeline events={[]} />)
    expect(screen.getByText('No events match.')).toBeTruthy()
  })

  it('renders plain labels newest-first, with campaign name and relative time', () => {
    const now = new Date('2026-10-11T12:00:00Z')
    const events: LeadEventRow[] = [
      { id: 2, type: 'reply_received', type_label: 'Reply received', category: 'email', occurred_at: new Date('2026-10-11T11:30:00Z'), campaign_id: 1, campaign_name: 'Fees angle', source: 'instantly_webhook', props: {} },
      { id: 1, type: 'custom', type_label: 'Custom event', category: 'custom', occurred_at: new Date('2026-10-11T10:00:00Z'), campaign_id: null, campaign_name: null, source: 'instantly_webhook', props: { instantly_type: 'lead_out_of_office' } },
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

describe('filterEvents (plan 2.10 timeline filter + search)', () => {
  const events: LeadEventRow[] = [
    { id: 1, type: 'reply_received', type_label: 'Reply received', category: 'email', occurred_at: new Date('2026-10-11T11:30:00Z'), campaign_id: 1, campaign_name: 'Fees angle', source: 'instantly_webhook', props: {} },
    { id: 2, type: 'stage_changed', type_label: 'Stage changed', category: 'lifecycle', occurred_at: new Date('2026-10-11T10:00:00Z'), campaign_id: null, campaign_name: null, source: 'dashboard', props: {} },
    { id: 3, type: 'meeting_booked', type_label: 'Meeting booked', category: 'meeting', occurred_at: new Date('2026-10-11T09:00:00Z'), campaign_id: 2, campaign_name: 'Renewal push', source: 'instantly_webhook', props: {} },
  ]

  it('returns everything with no filter', () => {
    expect(filterEvents(events)).toHaveLength(3)
  })

  it('filters by category exactly', () => {
    expect(filterEvents(events, { category: 'email' }).map((e) => e.id)).toEqual([1])
    expect(filterEvents(events, { category: 'meeting' }).map((e) => e.id)).toEqual([3])
  })

  it('searches label, type and campaign name, case-insensitively', () => {
    expect(filterEvents(events, { q: 'fees' }).map((e) => e.id)).toEqual([1])
    expect(filterEvents(events, { q: 'STAGE' }).map((e) => e.id)).toEqual([2])
    expect(filterEvents(events, { q: 'renewal' }).map((e) => e.id)).toEqual([3])
    expect(filterEvents(events, { q: 'nope' })).toHaveLength(0)
  })

  it('combines category and search (both must match)', () => {
    expect(filterEvents(events, { category: 'email', q: 'renewal' })).toHaveLength(0)
    expect(filterEvents(events, { category: 'email', q: 'fees' }).map((e) => e.id)).toEqual([1])
  })
})
