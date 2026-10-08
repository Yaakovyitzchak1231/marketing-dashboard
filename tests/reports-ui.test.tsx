import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { ConfirmAction } from '@/components/reports/ConfirmAction'
import { Count, Pct, LevelPill } from '@/components/reports/bits'

describe('ConfirmAction', () => {
  it('does nothing on the first click; shows what will happen and a confirm', () => {
    const action = vi.fn()
    render(<ConfirmAction action={action} fields={{ campaign_id: 'c1', kind: 'pause' }} label="Pause" confirmText="Pause “Seg 1” in Instantly?" confirmLabel="Pause campaign" />)
    expect(screen.queryByText('Pause campaign')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
    expect(action).not.toHaveBeenCalled()
    expect(screen.getByText('Pause “Seg 1” in Instantly?')).toBeTruthy()
    const group = screen.getByRole('group', { name: 'Confirm: Pause' })
    const hidden = Array.from(group.querySelectorAll('input[type=hidden]')).map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])
    expect(hidden).toEqual([['campaign_id', 'c1'], ['kind', 'pause'], ['confirm', 'yes']])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('renders disabled with the reason when actions are off', () => {
    render(<ConfirmAction action={vi.fn()} fields={{}} label="Resume" confirmText="x" disabled disabledReason="Instantly actions are off" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByTitle('Instantly actions are off').textContent).toBe('Resume')
  })
})

describe('report cells', () => {
  it('show "no data" for null and the measured value for zero', () => {
    const { container } = render(
      <div>
        <Count v={null} />|<Count v={0} />|<Count v={1234} />|<Pct v={null} />|<Pct v={0.0234} />
      </div>,
    )
    expect(container.textContent).toBe('no data|0|1,234|no data|2.3%')
  })

  it('names the runway level in words', () => {
    render(<LevelPill level="low" />)
    expect(screen.getByText('Under 14 days')).toBeTruthy()
  })
})
