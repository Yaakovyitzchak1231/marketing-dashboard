import { describe, it, expect } from 'vitest'
import { render } from '@testing-library/react'
import { TimelineFilters } from '@/components/leads/LeadTimeline'

// Review fix (#79, Viktor): the timeline filter jumped back to the Overview tab.
describe('Lead 360 timeline filter (#79)', () => {
  it('the filter form and its Clear link stay on the Timeline tab', () => {
    const { container } = render(<TimelineFilters category="email" q="open" />)
    const hidden = container.querySelector('input[type="hidden"][name="tab"]') as HTMLInputElement
    expect(hidden?.value).toBe('timeline')
    expect(container.querySelector('a')?.getAttribute('href')).toBe('?tab=timeline')
  })
})
