// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import React from 'react'

vi.mock('server-only', () => ({}))
vi.mock('@/app/actions/edit', () => ({ updateEntityAction: vi.fn(), entityHistoryAction: vi.fn() }))

import { InlineEditCell } from '@/components/edit/InlineEditCell'
import { HistoryDrawer } from '@/components/edit/HistoryDrawer'
import { updateEntityAction, entityHistoryAction } from '@/app/actions/edit'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('InlineEditCell', () => {
  it('shows the value, opens an input on click, saves on Enter and calls updateEntityAction', async () => {
    vi.mocked(updateEntityAction).mockResolvedValue({ ok: true, changed: true, field: 'name', from: 'Gem Co', to: 'Gem Co LLC' })
    render(<InlineEditCell type="company" id={7} field="name" value="Gem Co" label="Name for Gem Co" />)
    expect(screen.getByText('Gem Co')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name for Gem Co' }))
    const input = screen.getByLabelText('Name for Gem Co') as HTMLInputElement
    expect(input.value).toBe('Gem Co')
    fireEvent.change(input, { target: { value: 'Gem Co LLC' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(updateEntityAction).toHaveBeenCalledWith({ type: 'company', id: 7, field: 'name', value: 'Gem Co LLC' }))
    await waitFor(() => expect(screen.getByText('Gem Co LLC')).toBeInTheDocument())
  })

  it('Esc cancels without saving', () => {
    render(<InlineEditCell type="company" id={7} field="name" value="Gem Co" label="Name for Gem Co" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name for Gem Co' }))
    const input = screen.getByLabelText('Name for Gem Co') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Something else' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(screen.getByText('Gem Co')).toBeInTheDocument()
    expect(updateEntityAction).not.toHaveBeenCalled()
  })

  it('an unchanged value closes without calling the action', async () => {
    render(<InlineEditCell type="company" id={7} field="name" value="Gem Co" label="Name for Gem Co" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name for Gem Co' }))
    fireEvent.blur(screen.getByLabelText('Name for Gem Co'), { target: { value: 'Gem Co' } })
    expect(updateEntityAction).not.toHaveBeenCalled()
  })

  it('shows saving, then rolls back the optimistic value and shows the error when the save fails', async () => {
    vi.mocked(updateEntityAction).mockResolvedValue({ ok: false, error: 'Name is required.' })
    render(<InlineEditCell type="company" id={7} field="name" value="Gem Co" label="Name for Gem Co" />)
    fireEvent.click(screen.getByRole('button', { name: 'Edit Name for Gem Co' }))
    const input = screen.getByLabelText('Name for Gem Co') as HTMLInputElement
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Name is required.'))
    expect(screen.getByText('Gem Co')).toBeInTheDocument() // rolled back
  })

  it('renders a select when options are given, and saves on change', async () => {
    vi.mocked(updateEntityAction).mockResolvedValue({ ok: true, changed: true, field: 'stage', from: 'new', to: 'ready' })
    render(
      <InlineEditCell
        type="company"
        id={7}
        field="stage"
        value="new"
        label="Stage for Gem Co"
        options={[{ value: 'new', label: 'New' }, { value: 'ready', label: 'Ready' }]}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Edit Stage for Gem Co' }))
    const select = screen.getByLabelText('Stage for Gem Co') as HTMLSelectElement
    fireEvent.change(select, { target: { value: 'ready' } })
    await waitFor(() => expect(updateEntityAction).toHaveBeenCalledWith({ type: 'company', id: 7, field: 'stage', value: 'ready' }))
  })
})

describe('HistoryDrawer', () => {
  it('opens, loads history once, and lists each change in plain words', async () => {
    vi.mocked(entityHistoryAction).mockResolvedValue({
      ok: true,
      rows: [
        {
          id: 2, entity_type: 'company', entity_id: 7, field: 'stage', old_value: 'new', new_value: 'ready',
          changed_by: 'tab', changed_by_name: 'Tab', via: 'ops_api', note: null, changed_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
        },
      ],
    })
    render(<HistoryDrawer type="company" id={7} />)
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText(/Tab changed stage from new to ready/)).toBeInTheDocument()
    expect(screen.getByText(/via API/)).toBeInTheDocument()
    expect(entityHistoryAction).toHaveBeenCalledTimes(1)
  })

  it('shows an empty state when there is no history', async () => {
    vi.mocked(entityHistoryAction).mockResolvedValue({ ok: true, rows: [] })
    render(<HistoryDrawer type="company" id={8} />)
    fireEvent.click(screen.getByRole('button', { name: 'History' }))
    expect(await screen.findByText('No changes yet.')).toBeInTheDocument()
  })
})
