import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { PauseControl } from '@/components/ops/PauseControl'

afterEach(() => cleanup())

const noop = async () => {}

describe('Pause / Resume control', () => {
  it('first click only opens the confirm line with a reason field; nothing is submitted yet', () => {
    render(
      <PauseControl paused={false} pauseAction={noop} resumeAction={noop} fields={{ agent_id: 'tab' }}
        pauseLabel="Pause Tab" resumeLabel="Resume Tab" pauseText="Tab's requests will be refused until you resume." resumeText="Tab can work again." />,
    )
    expect(screen.queryByRole('group')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Pause Tab' }))
    const group = screen.getByRole('group', { name: 'Confirm: Pause Tab' })
    expect(group).toHaveTextContent("Tab's requests will be refused until you resume.")
    expect(screen.getByLabelText('Reason')).toBeInTheDocument()
    const hidden = Array.from(group.querySelectorAll('input[type=hidden]')).map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])
    expect(hidden).toEqual([['agent_id', 'tab'], ['confirm', 'yes']])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('group')).toBeNull()
  })

  it('a paused agent shows Resume, with no reason field', () => {
    render(
      <PauseControl paused pauseAction={noop} resumeAction={noop} fields={{ agent_id: 'tab' }}
        pauseLabel="Pause Tab" resumeLabel="Resume Tab" pauseText="x" resumeText="Tab can work again." />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Resume Tab' }))
    expect(screen.getByRole('group')).toHaveTextContent('Tab can work again.')
    expect(screen.queryByLabelText('Reason')).toBeNull()
  })
})
