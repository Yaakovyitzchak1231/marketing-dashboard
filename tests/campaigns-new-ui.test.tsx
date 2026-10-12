import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { NewCampaignForm } from '@/components/campaigns/NewCampaignForm'

afterEach(cleanup)

const pools = [{ id: 'jeweler', label: 'Jewelers' }, { id: 'dental', label: 'Dental' }]
const sources = [{ id: 7, name: 'Fall jewelers', is_template: true }]

describe('/campaigns/new step 1 (NewCampaignForm)', () => {
  it('renders the create form that hands off to the profile wizard', () => {
    render(<NewCampaignForm canEdit pools={pools} sources={sources} action={vi.fn()} />)
    expect(screen.getByLabelText('Name')).toBeTruthy()
    // the hidden flow=wizard field is what sends success to the profile wizard
    expect((screen.getByDisplayValue('wizard') as HTMLInputElement).name).toBe('flow')
    expect(screen.getByRole('option', { name: 'Dental' })).toBeTruthy()
    expect(screen.getByRole('option', { name: 'Template: Fall jewelers' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Create and set up profile' })).toBeTruthy()
    expect(screen.getByText(/Set up its profile/)).toBeTruthy()
  })

  it('shows an error passed back from the action', () => {
    render(<NewCampaignForm canEdit pools={pools} sources={[]} error="Name is required." action={vi.fn()} />)
    expect(screen.getByText('Name is required.')).toBeTruthy()
  })

  it('viewers get a view-only note and no form', () => {
    const { container } = render(<NewCampaignForm canEdit={false} pools={pools} sources={sources} action={vi.fn()} />)
    expect(screen.getByText(/View-only access/)).toBeTruthy()
    expect(container.querySelector('form')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
