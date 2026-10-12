// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { EventTypesSection, deactivateWarning } from '@/components/settings/EventTypesSection'
import type { EventTypeListRow } from '@/lib/events/types-store'

afterEach(() => cleanup())
const noop = async () => {}
const row = (o: Partial<EventTypeListRow>): EventTypeListRow => ({
  key: 'k', label: 'L', category: 'custom', source: 'dashboard', props_schema: null, active: true,
  created_by: null, created_at: '2026-10-10T00:00:00Z', created_by_name: null, stored_count: 0, ...o,
})
const types = [
  row({ key: 'email_sent', label: 'Email sent', category: 'email', source: 'instantly', stored_count: 1234 }),
  row({ key: 'review_posted', label: 'Review posted', category: 'signal', source: 'agent', active: false, created_by: 'hermes', created_by_name: 'Hermes', stored_count: 3 }),
  row({ key: 'demo_given', label: 'Demo given', category: 'meeting', source: 'dashboard', active: true, stored_count: 1520 }),
  row({ key: 'quote_sent', label: 'Quote sent', category: 'deal', source: 'dashboard', active: true, stored_count: 0 }),
]
const props = { types, registerAction: noop, updateAction: noop, setActiveAction: noop }

describe('EventTypesSection', () => {
  it('editor: register form, edit + toggle on custom types, built-ins fixed', () => {
    render(<EventTypesSection {...props} canEdit />)
    expect(screen.getByTestId('event-type-register')).toBeInTheDocument()
    const custom = screen.getByTestId('event-type-review_posted')
    expect(within(custom).getByRole('button', { name: 'Activate' })).toBeInTheDocument()
    expect(within(custom).getByLabelText('Label for review_posted')).toHaveValue('Review posted')
    expect(within(custom).getByText('Inactive')).toBeInTheDocument()
    expect(within(custom).getByText('Hermes')).toBeInTheDocument()
    const builtIn = screen.getByTestId('event-type-email_sent')
    expect(within(builtIn).queryByRole('button')).toBeNull()
    expect(within(builtIn).getByText('Fixed')).toBeInTheDocument()
    expect(within(builtIn).getByText('1234')).toBeInTheDocument()
    expect(screen.getByText(/refused by track_event/)).toBeInTheDocument()
  })

  it('viewer: read-only list, no forms or buttons', () => {
    const { container } = render(<EventTypesSection {...props} canEdit={false} />)
    expect(screen.queryByTestId('event-type-register')).toBeNull()
    expect(container.querySelectorAll('form, button, input, select')).toHaveLength(0)
    expect(screen.getByText('review_posted')).toBeInTheDocument()
  })

  it('Deactivate asks first, names the stored count, and only the confirm submits', () => {
    render(<EventTypesSection {...props} canEdit />)
    const live = screen.getByTestId('event-type-demo_given')
    // First click only opens the confirm line; no form posts active=false yet.
    expect(live.querySelector('input[name="active"][value="false"]')).toBeNull()
    fireEvent.click(within(live).getByRole('button', { name: 'Deactivate' }))
    const group = within(live).getByRole('group', { name: 'Confirm: Deactivate' })
    expect(within(group).getByText(/has 1,520 stored events/)).toBeInTheDocument()
    expect(within(group).getByText(/dropped, not saved/)).toBeInTheDocument()
    expect(group.querySelector('input[name="confirm"]')).toHaveValue('yes')
    expect(group.querySelector('input[name="active"]')).toHaveValue('false')
    expect(group.querySelector('input[name="key"]')).toHaveValue('demo_given')
    expect(within(group).getByRole('button', { name: 'Yes, deactivate' })).toHaveAttribute('type', 'submit')
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }))
    expect(within(live).queryByRole('group')).toBeNull()
    expect(within(live).getByRole('button', { name: 'Deactivate' })).toBeInTheDocument()
  })

  it('a type with no stored events still gets a confirm, with the plainer copy', () => {
    render(<EventTypesSection {...props} canEdit />)
    const unused = screen.getByTestId('event-type-quote_sent')
    fireEvent.click(within(unused).getByRole('button', { name: 'Deactivate' }))
    expect(within(unused).getByText('Deactivate quote_sent? track_event will refuse this key until you activate it again.')).toBeInTheDocument()
    expect(deactivateWarning({ key: 'x', stored_count: 1 })).toMatch(/has 1 stored event\./)
  })
})
