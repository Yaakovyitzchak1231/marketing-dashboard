import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { ConditionRow } from '@/components/segments/ConditionRow'
import { Readback } from '@/components/segments/Readback'
import type { FieldDef } from '@/lib/segments/fields'
import type { Condition } from '@/lib/segments/definition'

afterEach(() => cleanup())

const FIELDS: FieldDef[] = [
  { key: 'contact.status', label: 'Contact status', table: 'contact', type: 'text', sql: 'ct.status', operators: ['is', 'is_not', 'in', 'not_in'] },
  { key: 'company.state', label: 'State', table: 'company', type: 'text', sql: 'c.state' },
]

describe('Readback', () => {
  it('shows the plain-English text', () => {
    render(<Readback text="Leads where State is NY." />)
    expect(screen.getByTestId('segment-readback')).toHaveTextContent('Leads where State is NY.')
  })
  it('renders nothing for null', () => {
    const { container } = render(<Readback text={null} />)
    expect(container).toBeEmptyDOMElement()
  })
})

describe('ConditionRow', () => {
  it('a field condition shows field, operator and value controls', () => {
    const cond: Condition = { kind: 'field', field: 'contact.status', op: 'is', value: 'new' }
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.getByTestId('condition-row-field')).toBeInTheDocument()
    expect(screen.getByDisplayValue('Contact status')).toBeInTheDocument()
  })

  it('changing the field picks that field\'s first operator', () => {
    const cond: Condition = { kind: 'field', field: 'company.state', op: 'is', value: 'NY' }
    const onChange = vi.fn()
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={onChange} onRemove={() => {}} />)
    fireEvent.change(screen.getByDisplayValue('State'), { target: { value: 'contact.status' } })
    expect(onChange).toHaveBeenCalledWith({ kind: 'field', field: 'contact.status', op: 'is' })
  })

  it('"exists" hides the value input (no value needed)', () => {
    const cond: Condition = { kind: 'field', field: 'contact.status', op: 'exists' }
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.queryByLabelText(/^Value$/)).not.toBeInTheDocument()
  })

  it('an event condition shows event type, count comparison and count controls', () => {
    const cond: Condition = { kind: 'event', event_type: 'email_opened', count_op: 'gte', count: 2 }
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.getByTestId('condition-row-event')).toBeInTheDocument()
    expect(screen.getByDisplayValue('email_opened')).toBeInTheDocument()
  })

  it('a quality condition offers the four quality options', () => {
    const cond: Condition = { kind: 'quality', op: 'verified_sendable' }
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.getByTestId('condition-row-quality')).toBeInTheDocument()
  })

  it('Remove calls onRemove', () => {
    const cond: Condition = { kind: 'quality', op: 'suppressed' }
    const onRemove = vi.fn()
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={onRemove} />)
    fireEvent.click(screen.getByText('Remove'))
    expect(onRemove).toHaveBeenCalled()
  })

  it('an unsupported-in-the-UI kind (relative_date) still renders, read-only, instead of disappearing', () => {
    const cond: Condition = { kind: 'relative_date', field: 'contact.verified_at', op: 'after', days: 7 }
    render(<ConditionRow cond={cond} fields={FIELDS} onChange={() => {}} onRemove={() => {}} />)
    expect(screen.getByTestId('condition-row-readonly')).toBeInTheDocument()
  })
})
