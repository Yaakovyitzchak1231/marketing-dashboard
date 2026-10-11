import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
const { health } = vi.hoisted(() => ({ health: vi.fn() }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => null }))
vi.mock('@/lib/setup/db-status', () => ({ readDbStatus: async () => ({ connected: false, migrationsApplied: [] }) }))
vi.mock('@/lib/notify/health', () => ({ readDeliveryHealth: health }))
import SetupPage from '@/app/setup/page'

afterEach(cleanup)
describe('notification settings DOM', () => {
  it('shows stored delivery evidence and configuration prerequisites', async () => {
    health.mockResolvedValue({ available: true, agents: [{ id: 'tab', display_name: 'Tab', last_seen_at: null, channels: ['email'], unread: 4, held: 4, failed: 0, no_channel: 0 }] })
    render(await SetupPage())
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Unread: 4. Held: 4.')
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Last check-in: not recorded')
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Tab is @tab')
    expect(screen.getByTestId('setup-feature-notifications')).toHaveTextContent('MAIL_PROVIDER')
    expect(screen.getByTestId('setup-feature-notifications')).toHaveTextContent('Setting it does not create a schedule')
  })
  it('renders unavailable, not made-up zeroes, when the query fails', async () => {
    health.mockResolvedValue({ available: false, error: 'Delivery health is unavailable.' })
    render(await SetupPage())
    expect(screen.getByTestId('setup-delivery')).toHaveTextContent('Delivery health is unavailable.')
    expect(screen.getByTestId('setup-delivery')).not.toHaveTextContent('Unread: 0')
  })
})
