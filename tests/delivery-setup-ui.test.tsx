import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { DeliveryReadiness } from '@/components/settings/DeliveryReadiness'
import { envStatus } from '@/lib/setup/env'

afterEach(cleanup)
describe('notification settings DOM', () => {
  it('shows stored delivery evidence and configuration prerequisites', () => {
    render(
      <DeliveryReadiness
        health={{ available: true, agents: [{ id: 'tab', display_name: 'Tab', last_seen_at: null, channels: ['email'], unread: 4, held: 4, failed: 0, no_channel: 0 }] }}
        notificationEnv={envStatus('notifications', {})}
      />,
    )
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Unread: 4. Held: 4.')
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Last check-in: not recorded')
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Tab is @tab')
    expect(screen.getByTestId('setup-feature-notifications')).toHaveTextContent('MAIL_PROVIDER')
    expect(screen.getByTestId('setup-feature-notifications')).toHaveTextContent('Setting it does not create a schedule')
  })
  it('renders unavailable, not made-up zeroes, when the query fails', () => {
    render(
      <DeliveryReadiness
        health={{ available: false, error: 'Delivery health is unavailable.' }}
        notificationEnv={envStatus('notifications', {})}
      />,
    )
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Delivery health is unavailable.')
    expect(screen.getByTestId('setup-delivery')).not.toHaveTextContent('Unread: 0')
  })
})
