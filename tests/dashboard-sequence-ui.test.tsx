import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { SequencePlanView, shortDay } from '@/components/dashboard/SequencePlanView'
import type { SequencePlan } from '@/lib/dashboard/types'

afterEach(() => cleanup())

const plan: SequencePlan = {
  steps: [
    { step: 1, subject: 'hello', variants: 2, dayOffset: 0, sent: 12, status: 'sent', firstDate: '2026-10-01', nextDate: null },
    { step: 2, subject: null, variants: 1, dayOffset: 2, sent: 0, status: 'upcoming', firstDate: '2026-10-03', nextDate: '2026-10-13' },
    { step: 3, subject: 'last', variants: 1, dayOffset: 5, sent: null, status: 'upcoming', firstDate: null, nextDate: null },
  ],
  days: Array.from({ length: 16 }, (_, i) => ({ date: `2026-09-${String(10 + i).padStart(2, '0')}`, sent: i + 1, newLeads: i })),
}

describe('SequencePlanView', () => {
  it('shows every step, upcoming ones included, with dates', () => {
    render(<SequencePlanView plan={plan} />)
    expect(screen.getByText('12 sent')).toBeTruthy()
    expect(screen.getAllByText('Upcoming')).toHaveLength(2)
    expect(screen.getByText(/Scheduled from Oct 3/)).toBeTruthy()
    expect(screen.getByText(/next Oct 13 \(scheduled\)/)).toBeTruthy()
    expect(screen.getByText('No date yet')).toBeTruthy()
    expect(screen.getByText('(same thread)')).toBeTruthy()
  })

  it('lists send days newest first, 14 at a time', () => {
    render(<SequencePlanView plan={plan} />)
    const rows = screen.getAllByRole('row')
    expect(rows).toHaveLength(15) // header + 14
    expect(rows[1].textContent).toContain('Sep 25')
    fireEvent.click(screen.getByText('Show all 16 days'))
    expect(screen.getAllByRole('row')).toHaveLength(17)
  })

  it('says so when send dates are unavailable', () => {
    render(<SequencePlanView plan={{ ...plan, days: null }} />)
    expect(screen.getByText('Send dates are not available right now.')).toBeTruthy()
  })

  it('formats calendar dates without a timezone shift', () => {
    expect(shortDay('2026-10-01')).toBe('Oct 1')
  })
})
