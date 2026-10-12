import { describe, it, expect, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { AgentAdminCard } from '@/components/ops/AgentAdminCard'

afterEach(() => cleanup())
const noop = async () => {}
const hidden = (el: Element) => Array.from(el.querySelectorAll('input[type=hidden]')).map((i) => [(i as HTMLInputElement).name, (i as HTMLInputElement).value])

describe('Agent settings card', () => {
  it('enabled agent: rename prefilled, can_send off -> Turn on, disable behind a confirm', () => {
    const { container } = render(<AgentAdminCard agent={{ id: 'tab', display_name: 'Tab', active: true, can_send: false }} renameAction={noop} canSendAction={noop} activeAction={noop} />)
    expect(screen.getByLabelText('Name')).toHaveValue('Tab')
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument()
    const turnOn = screen.getByRole('button', { name: 'Turn on' })
    expect(hidden(turnOn.closest('form')!)).toEqual([['agent_id', 'tab'], ['can_send', 'true']])
    expect(container).toHaveTextContent('It approves nothing')
    const confirm = container.querySelector('[aria-label="Confirm: disable Tab"]')!
    expect(hidden(confirm)).toEqual([['agent_id', 'tab'], ['active', 'false'], ['confirm', 'yes']])
    expect(screen.getByText('Enabled')).toBeInTheDocument()
  })
  it('disabled agent: shows Disabled and a one-step Re-enable', () => {
    render(<AgentAdminCard agent={{ id: 'tab', display_name: 'Tab', active: false, can_send: true }} renameAction={noop} canSendAction={noop} activeAction={noop} />)
    expect(screen.getByText('Disabled')).toBeInTheDocument()
    const re = screen.getByRole('button', { name: 'Re-enable Tab' })
    expect(hidden(re.closest('form')!)).toEqual([['agent_id', 'tab'], ['active', 'true'], ['confirm', 'yes']])
    expect(screen.getByRole('button', { name: 'Turn off' })).toBeInTheDocument()
  })
  it('the name box refuses a whitespace-only name before submit (Kilo review, round 3)', () => {
    render(<AgentAdminCard agent={{ id: 'tab', display_name: 'Tab', active: true, can_send: false }} renameAction={noop} canSendAction={noop} activeAction={noop} />)
    const box = screen.getByLabelText('Name') as HTMLInputElement
    expect(box).toHaveAttribute('pattern', '.*\\S.*')
    box.value = '   '
    expect(box.checkValidity()).toBe(false)
    box.value = 'Tab Two'
    expect(box.checkValidity()).toBe(true)
  })
})
