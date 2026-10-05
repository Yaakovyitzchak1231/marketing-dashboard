// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { FunnelTable, type FunnelRow } from '@/components/funnel-manager'

const rows: FunnelRow[] = [
  { idea_name: 'Alpha', contacted: 100, replied: 10, positive: 1, meetings: null, customers: null, reply_rate: 0.1, positive_rate: 0.01, meeting_rate: null, close_rate: null },
  { idea_name: 'Beta', contacted: 200, replied: null, positive: null, meetings: null, customers: null, reply_rate: null, positive_rate: null, meeting_rate: null, close_rate: null },
  { idea_name: 'Gamma', contacted: 50, replied: 5, positive: 0, meetings: null, customers: null, reply_rate: 0.1, positive_rate: 0, meeting_rate: null, close_rate: null },
]

function rowOrder(): string[] {
  return screen
    .getAllByRole('row')
    .map((r) => r.textContent ?? '')
}

describe('FunnelTable sorting', () => {
  it('sinks an unreported figure in BOTH directions', () => {
    // The bug: an absent metric was `-Infinity` on the ascending pass
    // and `Infinity` on the descending one, so the unknowns floated
    // to the top the moment the direction was toggled.
    render(<FunnelTable rows={rows} label="Ideas" />)

    fireEvent.change(screen.getByLabelText('Sort ideas funnel'), {
      target: { value: 'replied' },
    })
    // Default direction is ascending: reported rows (Gamma, Alpha)
    // first, the unreported Beta last.
    expect(rowOrder().findIndex((t) => t.includes('Beta'))).toBeGreaterThan(
      rowOrder().findIndex((t) => t.includes('Gamma')),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Ascending' }))
    // Descending: the order of the reported rows reverses, and the
    // unknown STILL does not float to the top.
    const descending = rowOrder()
    expect(descending.findIndex((t) => t.includes('Beta'))).toBeGreaterThan(
      descending.findIndex((t) => t.includes('Alpha')),
    )
    // Reported rows reverse: Alpha (10 replies) before Gamma (5).
    expect(descending.findIndex((t) => t.includes('Alpha'))).toBeLessThan(
      descending.findIndex((t) => t.includes('Gamma')),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Descending' }))
    // Back to ascending, and the unknown is STILL last.
    expect(rowOrder().findIndex((t) => t.includes('Beta'))).toBeGreaterThan(
      rowOrder().findIndex((t) => t.includes('Gamma')),
    )
  })

  it('breaks a tie between reported rows by name', () => {
    // Alpha and Gamma both reply at 10%; a reproducible order is the
    // only honest one, and it must not depend on insertion order.
    render(<FunnelTable rows={rows} label="Ideas" />)
    fireEvent.change(screen.getByLabelText('Sort ideas funnel'), {
      target: { value: 'reply_rate' },
    })
    const order = rowOrder()
    expect(order.findIndex((t) => t.includes('Alpha'))).toBeLessThan(
      order.findIndex((t) => t.includes('Gamma')),
    )
  })

  it('exports the rows it just sorted, unreported figures as empty cells', () => {
    const chunks: string[] = []
    vi.stubGlobal(
      'Blob',
      class {
        constructor(parts: string[]) {
          chunks.push(...parts)
        }
      },
    )
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: () => 'blob:csv',
      revokeObjectURL: () => {},
    })
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

    render(<FunnelTable rows={rows} label="Ideas" />)
    fireEvent.click(screen.getByRole('button', { name: 'Export visible CSV' }))

    const csv = chunks.join('')
    // The Beta row carries no reply figure, so its cells are empty --
    // a 0 here would assert a measurement nobody made.
    expect(csv.split('\r\n').find((line) => line.startsWith('Beta'))).toBe(
      'Beta,200,,,,,,',
    )
  })
})
