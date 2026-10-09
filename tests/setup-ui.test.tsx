import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { DbNotConnected } from '@/components/app/PageShell'
import { NotConfigured } from '@/components/dashboard/NotConfigured'

afterEach(() => cleanup())

describe('Setup needed screens', () => {
  it('tells you exactly how to create DATABASE_URL and links straight to the Vercel settings', () => {
    vi.stubEnv('DATABASE_URL', '')
    vi.stubEnv('VERCEL_URL', 'marketing-dashboard-phjupca7m-yaakovyitzchak1231s-projects.vercel.app')
    vi.stubEnv('VERCEL_GIT_REPO_SLUG', 'marketing-dashboard')
    render(<DbNotConnected what="The Leads screen" />)
    const card = screen.getByTestId('db-not-connected')
    expect(card).toHaveTextContent('DATABASE_URL')
    expect(card).toHaveTextContent('Required')
    expect(card).toHaveTextContent('Missing')
    expect(screen.getByTestId('setup-steps-DATABASE_URL')).toHaveTextContent('Custom Prefix to DATABASE')
    const link = screen.getByTestId('vercel-env-link')
    expect(link).toHaveAttribute('href', 'https://vercel.com/yaakovyitzchak1231s-projects/marketing-dashboard/settings/environment-variables')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('falls back to the Vercel dashboard link outside Vercel', () => {
    vi.stubEnv('VERCEL_URL', '')
    render(<DbNotConnected what="The overview" />)
    expect(screen.getByTestId('vercel-env-link')).toHaveAttribute('href', 'https://vercel.com/dashboard')
  })

  it('never renders a key value, even for keys that are set', () => {
    vi.stubEnv('INSTANTLY_API_KEY', '')
    vi.stubEnv('DASHBOARD_TZ', 'Secret/ValueZone')
    const { container } = render(<NotConfigured />)
    expect(screen.getByTestId('not-configured')).toHaveTextContent('INSTANTLY_API_KEY')
    expect(screen.getByTestId('setup-key-DASHBOARD_TZ')).toHaveTextContent('Set')
    expect(container.innerHTML).not.toContain('Secret/ValueZone')
    expect(screen.getByTestId('setup-steps-INSTANTLY_API_KEY')).toHaveTextContent('Settings → Integrations → API Keys')
  })
})
