// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingTextField } from '@/components/settings/SettingTextField'
import { SecretField } from '@/components/settings/SecretField'
import { AgentsSection } from '@/components/settings/AgentsSection'
import { QuietHoursField } from '@/components/settings/QuietHoursField'
import { NeedsSetup } from '@/components/settings/NeedsSetup'
import { MAIL_PROVIDER_OPTIONS } from '@/lib/settings/registry'
import type { FormResult } from '@/app/actions/settings'

afterEach(() => cleanup())

const noopForm = async (): Promise<FormResult> => ({ ok: true })

describe('SettingTextField', () => {
  it('shows the current value and an env badge when the value comes from env', () => {
    render(<SettingTextField settingKey="workspace.timezone" label="Workspace timezone" value={null} source="env" action={noopForm} />)
    expect(screen.getByText('from env')).toBeInTheDocument()
    expect(screen.getByLabelText('Workspace timezone')).toHaveValue('')
  })

  it('shows a saved value with no source badge', () => {
    render(<SettingTextField settingKey="workspace.date_format" label="Date format" value="MMM D, YYYY" source="db" action={noopForm} />)
    expect(screen.getByLabelText('Date format')).toHaveValue('MMM D, YYYY')
    expect(screen.queryByText('from env')).toBeNull()
  })
})

describe('SettingTextField with options (Mail provider)', () => {
  it('renders a dropdown with Resend and Brevo, not a text box, and stores the lowercase value', () => {
    render(<SettingTextField settingKey="mail.provider" label="Mail provider" value="brevo" source="db" options={MAIL_PROVIDER_OPTIONS} action={noopForm} />)
    const sel = screen.getByLabelText('Mail provider') as HTMLSelectElement
    expect(sel.tagName).toBe('SELECT')
    expect(sel.value).toBe('brevo')
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(expect.arrayContaining(['Resend', 'Brevo']))
  })

  it('an unset field shows an obvious "Not set" badge and carries its anchor id', () => {
    const { container } = render(<SettingTextField settingKey="mail.from" anchorId="setting-mail-from" label="Mail sender" value={null} source="unset" action={noopForm} />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(container.querySelector('#setting-mail-from')).toBeTruthy()
  })
})

describe('QuietHoursField', () => {
  it('shows one range with two time pickers and the plain sentence', () => {
    render(<QuietHoursField start="21:00" end="08:00" action={noopForm} />)
    expect(screen.getByText('21:00 to 08:00')).toBeInTheDocument()
    expect(screen.getByText(/No emails go out between these hours, in your timezone; a campaign can override\./)).toBeInTheDocument()
    expect(screen.getByLabelText('Quiet hours start')).toHaveAttribute('type', 'time')
    expect(screen.getByLabelText('Quiet hours start')).toHaveValue('21:00')
    expect(screen.getByLabelText('Quiet hours end')).toHaveValue('08:00')
  })

  it('unset: "Not set" badge, and Save sends start and end together in one call', async () => {
    const calls: [string, string][] = []
    const action = async (_p: FormResult | null, f: FormData): Promise<FormResult> => {
      calls.push([String(f.get('start')), String(f.get('end'))])
      return { ok: true }
    }
    render(<QuietHoursField start={null} end={null} action={action} />)
    expect(screen.getByText('Not set')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Quiet hours start'), { target: { value: '22:00' } })
    fireEvent.change(screen.getByLabelText('Quiet hours end'), { target: { value: '07:30' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/Saved: no emails from 22:00 to 07:30/)).toBeInTheDocument()
    expect(calls).toEqual([['22:00', '07:30']])
  })
})

describe('NeedsSetup', () => {
  it('counts what is missing and links to each field by anchor', () => {
    render(
      <NeedsSetup
        items={[
          { key: 'mail.api_key', label: 'Mail API key', group: 'Email sending', anchor: 'setting-mail-api-key', optional: false },
          { key: 'umami.api_key', label: 'Umami API key', group: 'Integrations', anchor: 'setting-umami-api-key', optional: false },
          { key: 'ai.api_key', label: 'AI provider API key', group: 'AI', anchor: 'setting-ai-api-key', optional: true },
        ]}
      />,
    )
    expect(screen.getByText('2 things need setup')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Umami API key' })).toHaveAttribute('href', '#setting-umami-api-key')
    expect(screen.getByText(/Optional: AI provider API key/)).toBeInTheDocument()
  })

  it('nothing missing: says so plainly', () => {
    render(<NeedsSetup items={[]} />)
    expect(screen.getByText('Everything is set up.')).toBeInTheDocument()
  })
})

describe('SecretField', () => {
  it('"Not set" state: no Clear button, no value anywhere in the HTML', () => {
    const { container } = render(
      <SecretField
        settingKey="instantly.api_key"
        label="Instantly API key"
        status={{ set: false, last4: null, updated_at: null, updated_by: null }}
        envConfigured={false}
        testable
        settingsKeyReady
        replaceAction={noopForm}
        clearAction={noopForm}
        testAction={noopForm}
      />,
    )
    expect(screen.getByText('Not set')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull()
    expect(screen.queryByRole('button', { name: /Test/ })).toBeNull() // only shown once set
    expect(container.innerHTML).not.toMatch(/sk-/)
  })

  it('"Set \u00b7 ends in \u2026" state: shows last4 and who/when, Clear and Test are offered, no secret value anywhere', () => {
    const { container } = render(
      <SecretField
        settingKey="instantly.api_key"
        label="Instantly API key"
        status={{ set: true, last4: 'a1b2', updated_at: '2026-10-11T03:00:00Z', updated_by: 'owner' }}
        envConfigured={false}
        testable
        settingsKeyReady
        replaceAction={noopForm}
        clearAction={noopForm}
        testAction={noopForm}
      />,
    )
    expect(container.textContent).toContain('Set · …a1b2')
    expect(screen.getByText(/by owner/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Clear' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Test' })).toBeInTheDocument()
    expect(container.innerHTML).not.toMatch(/last4|a1b2c3/) // the real stored value, were it ever passed, would never render raw
  })

  it('when SETTINGS_KEY is not configured, the field is read-only: no Replace/Clear/Test controls', () => {
    render(
      <SecretField
        settingKey="instantly.api_key"
        label="Instantly API key"
        status={{ set: false, last4: null, updated_at: null, updated_by: null }}
        envConfigured={false}
        testable
        settingsKeyReady={false}
        replaceAction={noopForm}
        clearAction={noopForm}
        testAction={noopForm}
      />,
    )
    expect(screen.getByText(/Add SETTINGS_KEY/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull()
  })

  it('a password input is used for Replace, and it is never prefilled', () => {
    render(
      <SecretField
        settingKey="instantly.api_key"
        label="Instantly API key"
        status={{ set: true, last4: '9999', updated_at: null, updated_by: null }}
        envConfigured={false}
        testable={false}
        settingsKeyReady
        replaceAction={noopForm}
        clearAction={noopForm}
        testAction={noopForm}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Replace' }))
    const input = document.querySelector('input[type="password"]') as HTMLInputElement
    expect(input).toBeTruthy()
    expect(input.value).toBe('')
  })
})

describe('AgentsSection', () => {
  it('lists agents (not people) with their current takes_kinds as ticked boxes, none ticked meaning any', () => {
    const { container } = render(
      <AgentsSection
        actors={[
          { id: 'owner', display_name: 'Yaakov', kind: 'human', takes_kinds: [] },
          { id: 'tab', display_name: 'Tab', kind: 'agent', takes_kinds: ['find_leads', 'verify_contacts'] },
          { id: 'hermes', display_name: 'Hermes', kind: 'agent', takes_kinds: [] },
        ]}
        action={noopForm}
      />,
    )
    expect(screen.queryByText('Yaakov')).toBeNull()
    expect(screen.getByText('Tab')).toBeInTheDocument()
    expect(screen.getByLabelText('Tab: Find leads')).toBeChecked()
    expect(screen.getByLabelText('Tab: Verify emails')).toBeChecked()
    expect(screen.getByLabelText('Tab: Send emails')).not.toBeChecked()
    expect(screen.getByLabelText('Hermes: Find leads')).not.toBeChecked()
    expect(screen.getByText('Takes any kind')).toBeInTheDocument()
    // no free-text box any more
    expect(container.querySelector('input[name="takes_kinds"][type="hidden"]')).toBeTruthy()
    expect(container.querySelector('input[type="text"], input:not([type])')).toBeNull()
  })

  it('ticking a kind updates the comma-joined value the server action reads (same stored shape)', () => {
    const { container } = render(<AgentsSection actors={[{ id: 'hermes', display_name: 'Hermes', kind: 'agent', takes_kinds: [] }]} action={noopForm} />)
    const hidden = () => (container.querySelector('input[name="takes_kinds"]') as HTMLInputElement).value
    expect(hidden()).toBe('')
    fireEvent.click(screen.getByLabelText('Hermes: Find leads'))
    fireEvent.click(screen.getByLabelText('Hermes: Research a company'))
    expect(hidden()).toBe('find_leads,research_company')
    fireEvent.click(screen.getByRole('button', { name: 'Clear (any kind)' }))
    expect(hidden()).toBe('')
  })

  it('a saved kind that is not in the known list still shows (ticked), so nothing saved is hidden', () => {
    render(<AgentsSection actors={[{ id: 'tab', display_name: 'Tab', kind: 'agent', takes_kinds: ['custom_thing'] }]} action={noopForm} />)
    expect(screen.getByLabelText('Tab: custom thing')).toBeChecked()
  })

  it('no agents: an honest empty state', () => {
    render(<AgentsSection actors={[{ id: 'owner', display_name: 'Yaakov', kind: 'human', takes_kinds: [] }]} action={noopForm} />)
    expect(screen.getByText('No agents yet.')).toBeInTheDocument()
  })
})
