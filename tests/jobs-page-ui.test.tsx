// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'

const holder: { db: unknown } = { db: null }
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

const jobsFixture = vi.hoisted(() => ({ jobs: [] as unknown[], runs: [] as unknown[] }))
vi.mock('@/lib/jobs/store', () => ({
  listJobs: vi.fn(async () => jobsFixture.jobs),
  listJobRuns: vi.fn(async () => jobsFixture.runs),
}))
const campaignsFixture = vi.hoisted(() => ({ campaigns: [] as unknown[] }))
vi.mock('@/lib/campaigns/store', () => ({
  listCampaigns: vi.fn(async () => campaignsFixture.campaigns),
}))

afterEach(() => {
  cleanup()
  jobsFixture.jobs = []
  jobsFixture.runs = []
  campaignsFixture.campaigns = []
})

const job = (over: Partial<Record<string, unknown>> = {}) => ({
  name: 'nightly-heartbeat', kind: 'heartbeat', description: null, schedule_cron: '0 9 * * *', timezone: 'America/New_York',
  campaign_id: null, payload: {}, enabled: true, timeout_s: 600, next_run_at: new Date(Date.now() + 3600_000).toISOString(),
  last_run_at: null, last_status: null, last_error: null, locked_by: null, locked_until: null, created_by: 'owner',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...over,
})
const run = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1, job_name: 'nightly-heartbeat', campaign_id: null, runner: 'r', actor: 'system', status: 'ok',
  started_at: new Date().toISOString(), finished_at: new Date().toISOString(), output: null, error: null, ...over,
})

describe('/jobs page', () => {
  it("shows an honest empty state when the database isn't connected", async () => {
    holder.db = null
    const { default: JobsPage } = await import('@/app/jobs/page')
    const jsx = await JobsPage({ searchParams: Promise.resolve({}) })
    render(jsx)
    expect(screen.getByText(/database isn.t connected/i)).toBeInTheDocument()
  })

  it('lists jobs with their kind, campaign, schedule, next run and last status', async () => {
    holder.db = {}
    campaignsFixture.campaigns = [{ id: 7, name: 'Restaurants Q4' }]
    jobsFixture.jobs = [job({ campaign_id: 7 }), job({ name: 'on-demand-only', kind: 'http_ping', enabled: false, schedule_cron: null, next_run_at: null })]
    jobsFixture.runs = []

    const { default: JobsPage } = await import('@/app/jobs/page')
    const jsx = await JobsPage({ searchParams: Promise.resolve({}) })
    render(jsx)

    expect(screen.getByText('nightly-heartbeat')).toBeInTheDocument()
    expect(screen.getByText('heartbeat')).toBeInTheDocument()
    expect(screen.getAllByText('Restaurants Q4').length).toBeGreaterThan(0)
    expect(screen.getByText(/daily at 9:00am/)).toBeInTheDocument()
    expect(screen.getByText('on-demand-only')).toBeInTheDocument()
    expect(screen.getByText('disabled')).toBeInTheDocument()
    expect(screen.getAllByText('never run').length).toBeGreaterThan(0)
  })

  it("shows a job's last run status and surfaces failed runs with their error", async () => {
    holder.db = {}
    jobsFixture.jobs = [job({ name: 'flaky-job' })]
    jobsFixture.runs = [run({ job_name: 'flaky-job', status: 'failed', error: 'the API answered 500' })]

    const { default: JobsPage } = await import('@/app/jobs/page')
    const jsx = await JobsPage({ searchParams: Promise.resolve({}) })
    render(jsx)

    expect(screen.getAllByText('flaky-job').length).toBeGreaterThan(0)
    expect(screen.getAllByText('failed').length).toBeGreaterThan(0)
    expect(screen.getByText('the API answered 500')).toBeInTheDocument()
  })

  it('an empty jobs list says so honestly, not a fake zero', async () => {
    holder.db = {}
    const { default: JobsPage } = await import('@/app/jobs/page')
    const jsx = await JobsPage({ searchParams: Promise.resolve({}) })
    render(jsx)
    expect(screen.getByText('No jobs yet. Add one below.')).toBeInTheDocument()
    expect(screen.getByText('No failed or timed-out runs.')).toBeInTheDocument()
  })

  it('shows an error message passed via ?error=', async () => {
    holder.db = {}
    const { default: JobsPage } = await import('@/app/jobs/page')
    const jsx = await JobsPage({ searchParams: Promise.resolve({ error: 'bad schedule: minute: 60 is out of range' }) })
    render(jsx)
    expect(screen.getByText('bad schedule: minute: 60 is out of range')).toBeInTheDocument()
  })
})
