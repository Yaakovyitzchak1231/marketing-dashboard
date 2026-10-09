import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import './mock-navigation'
import { StepsEditor, type StepView } from '@/components/campaign-steps/StepsEditor'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const campaign = { id: 7, name: 'MD jewelers', segment: 'jeweler', rule_set_id: null, instantly_campaign_id: null, instantly_linked_at: null, instantly_linked_by: null }
const step: StepView = {
  id: 1, campaign_id: 7, step_number: 1, variant: 'A', subject: 'Hi {{firstName}}', body: 'See gemco.com. Thanks.', delay_days: 0,
  created_by: 'owner', updated_by: 'owner', created_at: new Date(), updated_at: new Date(),
  warnings: [{ code: 'has_link', message: 'Has a link. Jeweler emails should have no links.' }, { code: 'no_question', message: 'Doesn’t end with a question.' }],
}
const fields = [{ id: 'f1', name: 'firstName', source: 'contact.first_name', required: false, fallback: 'there', enabled: true }]

describe('Steps tab', () => {
  it('shows steps with copy warnings, the fields, and no push button until Instantly is linked', () => {
    render(<StepsEditor campaign={campaign} steps={[step]} fields={fields} fieldsFrom="rules: Jewelers" pushRequests={[]} leads={[]} />)
    expect(screen.getByText('Step 1')).toBeInTheDocument()
    expect(screen.getByLabelText('Copy warnings')).toHaveTextContent('Has a link')
    expect(screen.getByText('{{firstName}}')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Ask to push/ })).toBeNull()
    expect(screen.getByRole('button', { name: 'Move step 1 up' })).toBeDisabled()
  })

  it('loads a lead preview and flags what is missing', async () => {
    const preview = {
      campaign, lead: { company_id: 3, company_name: 'Bare Gems', contact_id: 9, email: 'hello@baregems.com', overrides: {} },
      fields_from: 'x', fields: [{ name: 'firstName', source: 'contact.first_name', required: true, value: null, from: null, real: false }],
      steps: [{ step, subject: { text: 'Hi {{firstName}}', used: ['firstName'], fallbacks: [], leftovers: ['firstName'], unknown: [] }, body: { text: 'x', used: [], fallbacks: [], leftovers: [], unknown: [] }, warnings: [{ code: 'leftover', message: 'Subject has unfilled {{firstName}}' }] }],
      missing_required: ['firstName'], leftovers: ['firstName'], outlook: 'parked', outlook_why: ['Would go out with {{firstName}} unfilled'], verdict: null,
    }
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, preview }), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    render(<StepsEditor campaign={campaign} steps={[step]} fields={fields} fieldsFrom="x" pushRequests={[]} leads={[{ company_id: 3, company_name: 'Bare Gems', email: null }]} />)
    fireEvent.change(screen.getByLabelText('Lead'), { target: { value: '3' } })
    await waitFor(() => expect(screen.getByTestId('lead-preview')).toBeInTheDocument())
    expect(fetchMock).toHaveBeenCalledWith('/api/campaign-steps/7/preview?lead=3', expect.objectContaining({ method: 'GET' }))
    expect(screen.getByText('Copy: would be Parked')).toBeInTheDocument()
    expect(screen.getByText('missing')).toBeInTheDocument()
  })
})
