import { describe, it, expect } from 'vitest'
import { ENV_SPECS, envStatus, vercelEnvSettingsUrl, vercelProject, vercelProjectUrl } from '@/lib/setup/env'

// The real shape of this project's deployment URLs (from its GitHub deployment statuses).
const VERCEL = {
  VERCEL_URL: 'marketing-dashboard-phjupca7m-yaakovyitzchak1231s-projects.vercel.app',
  VERCEL_GIT_REPO_SLUG: 'marketing-dashboard',
}

describe('Vercel links', () => {
  it('builds the exact Environment Variables URL from Vercel system variables', () => {
    expect(vercelProject(VERCEL)).toEqual({ team: 'yaakovyitzchak1231s-projects', project: 'marketing-dashboard' })
    expect(vercelEnvSettingsUrl(VERCEL)).toEqual({
      url: 'https://vercel.com/yaakovyitzchak1231s-projects/marketing-dashboard/settings/environment-variables',
      exact: true,
    })
    expect(vercelProjectUrl(VERCEL)).toBe('https://vercel.com/yaakovyitzchak1231s-projects/marketing-dashboard')
  })
  it('prefers VERCEL_PROJECT_NAME when the project is not named after the repo', () => {
    expect(vercelProject({ VERCEL_URL: 'tapdash-ab12cd34e-acme.vercel.app', VERCEL_GIT_REPO_SLUG: 'marketing-dashboard', VERCEL_PROJECT_NAME: 'tapdash' })).toEqual({
      team: 'acme',
      project: 'tapdash',
    })
  })
  it('falls back to the Vercel dashboard when it cannot tell', () => {
    expect(vercelEnvSettingsUrl({})).toEqual({ url: 'https://vercel.com/dashboard', exact: false })
    expect(vercelEnvSettingsUrl({ VERCEL_URL: 'localhost:3000' }).exact).toBe(false)
    expect(vercelEnvSettingsUrl({ VERCEL_URL: 'other-ab12cd34e-acme.vercel.app', VERCEL_GIT_REPO_SLUG: 'marketing-dashboard' }).exact).toBe(false)
  })
  it('handles a project name that contains dashes', () => {
    expect(vercelProject({ VERCEL_URL: 'my-project-ab12cd34e-acme.vercel.app', VERCEL_GIT_REPO_SLUG: 'my-project' })).toEqual({
      team: 'acme',
      project: 'my-project',
    })
  })
  it('falls back to the dashboard for a custom domain', () => {
    expect(vercelEnvSettingsUrl({ VERCEL_URL: 'app.example.com', VERCEL_GIT_REPO_SLUG: 'app' }).exact).toBe(false)
  })
  it('falls back to the dashboard for a production hostname (no team segment)', () => {
    // Production URLs are `<project>.vercel.app` — no team to derive, so we never link.
    expect(vercelEnvSettingsUrl({ VERCEL_URL: 'marketing-dashboard.vercel.app', VERCEL_GIT_REPO_SLUG: 'marketing-dashboard' }).exact).toBe(false)
  })
  it('falls back to the dashboard for a preview URL in an unknown format', () => {
    expect(vercelEnvSettingsUrl({ VERCEL_URL: 'weird-git-branch.vercel.app', VERCEL_GIT_REPO_SLUG: 'marketing-dashboard' }).exact).toBe(false)
  })
})

describe('envStatus', () => {
  it('exposes mail and retry prerequisites without exposing credentials or promising a schedule', () => {
    const keys = envStatus('notifications', { MAIL_PROVIDER: 'resend', MAIL_API_KEY: 'private-test-value', CRON_SECRET: 'private-scheduler-value' })
    expect(keys.map((k) => k.key)).toEqual(['MAIL_PROVIDER', 'MAIL_API_KEY', 'MAIL_FROM', 'CRON_SECRET'])
    expect(keys.find((k) => k.key === 'MAIL_FROM')?.set).toBe(false)
    expect(JSON.stringify(keys)).not.toContain('private-test-value')
    expect(JSON.stringify(keys)).not.toContain('private-scheduler-value')
    expect(keys.find((k) => k.key === 'CRON_SECRET')?.purpose).toContain('does not create a schedule')
  })
  it('says set or missing, never the value', () => {
    const s = envStatus('leads', { DATABASE_URL: 'postgres://u:hunter2@h/db' })
    expect(s[0]).toMatchObject({ key: 'DATABASE_URL', required: true, set: true })
    expect(JSON.stringify(s)).not.toContain('hunter2')
    expect(envStatus('leads', { DATABASE_URL: '  ' })[0].set).toBe(false)
  })
  it('marks required vs optional keys and gives the Neon steps with the DATABASE prefix', () => {
    expect(ENV_SPECS.agents[0]).toMatchObject({ key: 'OPS_AGENT_TOKENS', required: false })
    expect(ENV_SPECS.dashboard.find((k) => k.key === 'DASHBOARD_TZ')?.required).toBe(false)
    const steps = ENV_SPECS.leads[0].steps.join(' ')
    expect(steps).toMatch(/Storage/)
    expect(steps).toMatch(/Neon/)
    expect(steps).toMatch(/Custom Prefix to DATABASE/)
    expect(steps).toMatch(/Redeploy/)
  })
})
