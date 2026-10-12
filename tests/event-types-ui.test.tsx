// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { EventTypesSection } from '@/components/settings/EventTypesSection'
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
})
