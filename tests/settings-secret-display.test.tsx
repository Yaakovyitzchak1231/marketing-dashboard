// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SecretField } from '@/components/settings/SecretField'
import { ModelPicker } from '@/components/settings/ModelPicker'
import type { FormResult } from '@/app/actions/settings'

afterEach(() => cleanup())

const noopForm = async (): Promise<FormResult> => ({ ok: true })
const noopVoid = async () => {}
const base = { settingKey: 'mail.api_key', label: 'Mail API key', testable: false, settingsKeyReady: true, replaceAction: noopForm, clearAction: noopVoid, testAction: noopForm }

describe('SecretField: last 4 + when set, everywhere', () => {
  it('saved secret: "Set · …a1b2" and the date and time it was set', () => {
    render(
      <SecretField {...base} status={{ set: true, last4: 'a1b2', updated_at: '2026-10-11T13:56:00Z', updated_by: 'owner' }} envConfigured={false} timeZone="America/New_York" />,
    )
    expect(screen.getByText('Set · …a1b2')).toBeInTheDocument()
    expect(screen.getByText('Set Oct 11, 2026, 9:56 AM by owner')).toBeInTheDocument()
  })

  it('env-backed secret: last 4 from env and when the dashboard first saw it', () => {
    render(
      <SecretField
        {...base}
        status={{ set: false, last4: null, updated_at: null, updated_by: null }}
        envConfigured
        envLast4="WXYZ"
        envSeenAt="2026-10-11T13:54:00Z"
        timeZone="America/New_York"
      />,
    )
    expect(screen.getByText('From Vercel env · …WXYZ')).toBeInTheDocument()
    expect(screen.getByText(/First seen Oct 11, 2026, 9:54 AM/)).toBeInTheDocument()
  })

  it('env-backed with no first-seen record says so instead of guessing', () => {
    render(<SecretField {...base} status={{ set: false, last4: null, updated_at: null, updated_by: null }} envConfigured envLast4="WXYZ" />)
    expect(screen.getByText(/date it was set is not recorded/)).toBeInTheDocument()
  })
})

describe('ModelPicker', () => {
  it('loads the provider list into a dropdown with a "type a model name" fallback', async () => {
    const loadModels = async () => ({ ok: true as const, models: ['gemma2-9b-it', 'llama-3.1-8b-instant'] })
    await act(async () => {
      render(<ModelPicker settingKey="ai.model" label="AI model" value="llama-3.1-8b-instant" source="db" providerReady action={noopForm} loadModels={loadModels} />)
    })
    const select = screen.getByLabelText('AI model') as HTMLSelectElement
    expect(select.tagName).toBe('SELECT')
    expect(select.value).toBe('llama-3.1-8b-instant')
    expect(screen.getByRole('option', { name: 'gemma2-9b-it' })).toBeInTheDocument()
    fireEvent.change(select, { target: { value: '__type_own__' } })
    expect((screen.getByLabelText('AI model') as HTMLElement).tagName).toBe('INPUT')
    expect(screen.getByRole('button', { name: 'Pick from the list' })).toBeInTheDocument()
  })

  it('list fails: plain message and a text box', async () => {
    const loadModels = async () => ({ ok: false as const, message: 'The provider rejected the API key.' })
    await act(async () => {
      render(<ModelPicker settingKey="ai.model" label="AI model" value={null} source="unset" providerReady action={noopForm} loadModels={loadModels} />)
    })
    expect((screen.getByLabelText('AI model') as HTMLElement).tagName).toBe('INPUT')
    expect(screen.getByText(/rejected the API key\. You can type a model name instead\./)).toBeInTheDocument()
  })

  it('no provider yet: text box and a hint, no fetch', async () => {
    let called = false
    const loadModels = async () => {
      called = true
      return { ok: true as const, models: [] }
    }
    await act(async () => {
      render(<ModelPicker settingKey="ai.model" label="AI model" value={null} source="unset" providerReady={false} action={noopForm} loadModels={loadModels} />)
    })
    expect(called).toBe(false)
    expect(screen.getByText(/Set the AI provider base URL above/)).toBeInTheDocument()
  })
})
