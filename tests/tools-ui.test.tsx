// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import React from 'react'
import { HealthRow, LinkCard, MetricRow, ToolCard } from '@/components/tools/ToolCard'
import type { Integration, LatestMetric } from '@/lib/integrations/store'

const NOW = new Date('2026-10-11T04:00:00Z')

function integration(over: Partial<Integration> = {}): Integration {
  return {
    id: 'listmonk',
    name: 'Listmonk',
    kind: 'listmonk',
    description: 'Newsletters to opted-in leads.',
    url: 'http://100.104.103.48:18510/admin',
    api_url: 'http://127.0.0.1:18510',
    reachable_from: 'tailnet',
    settings_prefix: 'integrations.listmonk',
    visibility: 'owner',
    sort: 20,
    active: true,
    health_status: null,
    health_detail: null,
    health_checked_at: null,
    created_by: null,
    updated_by: null,
    created_at: NOW,
    updated_at: NOW,
    ...over,
  }
}

describe('HealthRow', () => {
  it('says "not checked yet" (never a fake status) when the runner has not reported', () => {
    render(<HealthRow integration={integration()} now={NOW} />)
    expect(screen.getByText(/not checked yet/i)).toBeInTheDocument()
    expect(screen.getByText(/runner not deployed/i)).toBeInTheDocument()
  })

  it('shows the reported status and how long ago it was checked', () => {
    const checkedAt = new Date(NOW.getTime() - 5 * 60_000)
    render(<HealthRow integration={integration({ health_status: 'ok', health_detail: 'HTTP 200', health_checked_at: checkedAt })} now={NOW} />)
    expect(screen.getByText('Healthy')).toBeInTheDocument()
    expect(screen.getByText(/checked/i)).toHaveTextContent('checked 5m ago')
  })

  it('shows degraded and down distinctly', () => {
    const checkedAt = new Date(NOW.getTime() - 60_000)
    const { rerender } = render(<HealthRow integration={integration({ health_status: 'degraded', health_checked_at: checkedAt })} now={NOW} />)
    expect(screen.getByText('Degraded')).toBeInTheDocument()
    rerender(<HealthRow integration={integration({ health_status: 'down', health_checked_at: checkedAt })} now={NOW} />)
    expect(screen.getByText('Down')).toBeInTheDocument()
  })
})

describe('MetricRow', () => {
  function metric(over: Partial<LatestMetric> = {}): LatestMetric {
    return { integration_id: 'listmonk', metric: 'listmonk.subscribers', value: 42, dims: {}, data: null, campaign_id: null, taken_at: NOW, source: 'runner', ...over }
  }

  it('shows a reported number', () => {
    render(
      <ul>
        <MetricRow metric={metric({ value: 42, dims: { list: 'Fall Jewelers' } })} />
      </ul>,
    )
    expect(screen.getByText('Subscribers')).toBeInTheDocument()
    expect(screen.getByText(/Fall Jewelers/)).toBeInTheDocument()
    expect(screen.getByText('42')).toBeInTheDocument()
  })

  it('shows "—" with a "not reported" tooltip for a null value, never 0', () => {
    render(
      <ul>
        <MetricRow metric={metric({ value: null })} />
      </ul>,
    )
    const dash = screen.getByText('—')
    expect(dash).toBeInTheDocument()
    expect(dash).toHaveAttribute('title', expect.stringMatching(/not reported/i))
    expect(screen.queryByText('0')).not.toBeInTheDocument()
  })
})

describe('ToolCard', () => {
  it('renders name, description, Open link, the tailnet note, health and metrics', () => {
    const tool = integration()
    const metrics: LatestMetric[] = [
      { integration_id: 'listmonk', metric: 'listmonk.subscribers', value: 88, dims: { list: 'Restaurants Q4' }, data: null, campaign_id: 1, taken_at: NOW, source: 'runner' },
    ]
    render(<ToolCard integration={tool} metrics={metrics} now={NOW} />)
    expect(screen.getByRole('heading', { name: 'Listmonk' })).toBeInTheDocument()
    expect(screen.getByText('Newsletters to opted-in leads.')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', tool.url)
    expect(screen.getByText(/tailnet only/i)).toBeInTheDocument()
    expect(screen.getByText(/not checked yet/i)).toBeInTheDocument()
    expect(screen.getByText('88')).toBeInTheDocument()
  })

  it('a public tool (Warmbly) shows no tailnet note', () => {
    render(<ToolCard integration={integration({ id: 'warmbly', name: 'Warmbly', reachable_from: 'public' })} metrics={[]} now={NOW} />)
    expect(screen.queryByText(/tailnet only/i)).not.toBeInTheDocument()
  })
})

describe('LinkCard (docs/sheets)', () => {
  it('renders a plain link card with no health row', () => {
    render(
      <LinkCard
        integration={integration({
          id: 'build_tracker',
          name: 'Build tracker',
          kind: 'sheet',
          description: 'The build status sheet.',
          url: 'https://docs.google.com/spreadsheets/d/abc/edit',
        })}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Build tracker' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', 'https://docs.google.com/spreadsheets/d/abc/edit')
    expect(screen.queryByText(/not checked yet/i)).not.toBeInTheDocument()
  })
})
