import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MailInUse } from '@/components/settings/MailInUse'

describe('MailInUse', () => {
  it('shows the effective values, their source, and only the key last 4', () => {
    render(<MailInUse keySet keySource="env" provider="resend" providerSource="env" from="TapDash <onboarding@resend.dev>" fromSource="env" keyLast4="a1b2" keySeenAt="2026-10-11T13:54:00Z" timeZone="America/New_York" />)
    expect(screen.getByText('Sending')).toBeTruthy()
    expect(screen.getByText('Settings first, then Vercel')).toBeTruthy()
    expect(screen.getByText('resend')).toBeTruthy()
    expect(screen.getByText(/…a1b2/)).toBeTruthy()
    expect(screen.getByText(/first seen Oct 11, 2026/)).toBeTruthy()
    expect(screen.getByText(/Values saved on Settings take precedence/)).toBeTruthy()
  })

  it('flags each missing piece as Not set', () => {
    render(<MailInUse keySet={false} keySource="unset" provider={null} providerSource="unset" from={null} fromSource="unset" keyLast4={null} keySeenAt={null} />)
    expect(screen.getByText('Not sending yet')).toBeTruthy()
    expect(screen.getAllByText('Not set')).toHaveLength(3)
  })
})
