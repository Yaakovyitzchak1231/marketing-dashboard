import { describe, it, expect } from 'vitest'
import { buildShellModel } from '@/lib/shell-model'
import type { Overview, CampaignList, CampaignTrend, Freshness } from '@/lib/api-types'

/**
 * The shell model is the seam between the API contract and the render path.
 *
 * Everything below is a pure function of what the API returned, so the honesty
 * rules can be asserted without a DOM, a server, or a network. The components
 * consume this model and never touch a raw response.
 */

const overview: Overview = {
  emails_sent: 31893,
  replies_human: 1357,
  replies_autoresponder: 39,
  bounces: 120,
  opportunities: 22,
  opportunity_value: 125000,
  mailbox_count: 12,
  healthy_mailboxes: 10,
  reply_rate: 0.0426,
  bounce_rate: 0.0038,
  // The API does not populate these. They are null, not zero.
  open_rate: null,
  unsubscribe: null,
  range: '7d',
}

const campaigns: CampaignList = {
  campaigns: [
    {
      id: 'c1',
      external_id: 'e1',
      name: 'PB Signups / Leads',
      status: 'active',
      created_at: '2026-09-01',
      emails_sent: 31893,
      replies_human: 1357,
      replies_autoresponder: 39,
      bounces: 120,
      opportunities: 22,
      reply_rate: 0.0426,
      bounce_rate: 0.0038,
      open_rate: null,
      unsubscribe: null,
      metric_date: '2026-09-30',
    },
  ],
  range: '7d',
  sort: 'emails_sent',
  order: 'desc',
}

describe('buildShellModel', () => {
  const freshness: Freshness = { generatedAt: '2026-09-30T14:05:00Z', collectionFailed: false }

  it('maps the overview response onto KPI cells without inventing a value', () => {
    const model = buildShellModel({ overview, campaigns, trend: null, freshness })
    const byKey = Object.fromEntries(model.kpis.map((k) => [k.key, k]))

    expect(byKey.emails_sent?.value).toBe(31893)
    expect(byKey.emails_sent?.kind).toBe('count')
    expect(byKey.reply_rate?.value).toBe(0.0426)
    expect(byKey.reply_rate?.kind).toBe('rate')
  })

  it('carries open rate and unsubscribe through as null, never zero', () => {
    // The exact bug: 0.0% because the API does not populate these. A `?? 0`
    // anywhere in this mapping would resurrect it.
    const model = buildShellModel({ overview, campaigns, trend: null, freshness })
    const byKey = Object.fromEntries(model.kpis.map((k) => [k.key, k]))
    expect(byKey.open_rate?.value).toBeNull()
    expect(byKey.unsubscribe?.value).toBeNull()
  })

  it('passes a campaign row through without remapping its fields', () => {
    const model = buildShellModel({ overview, campaigns, trend: null, freshness })
    expect(model.campaigns).toHaveLength(1)
    expect(model.campaigns[0].name).toBe('PB Signups / Leads')
    expect(model.campaigns[0].open_rate).toBeNull()
  })

  it('marks a campaign list as partial only when the source says it is', () => {
    const full = buildShellModel({ overview, campaigns, trend: null, freshness })
    expect(full.campaignTotal).toBeNull()

    const truncated = buildShellModel({
      overview,
      campaigns: { ...campaigns, total: 148 },
      trend: null,
      freshness,
    })
    expect(truncated.campaignTotal).toBe(148)
  })

  it('treats an empty trend series as a first-run state, not an error', () => {
    const model = buildShellModel({ overview, campaigns, trend: null, freshness })
    expect(model.trend).toEqual([])
    expect(model.trendError).toBe(false)
  })

  it('reports a trend error separately so the chart can say so', () => {
    const model = buildShellModel({
      overview,
      campaigns,
      trend: null,
      freshness,
      trendFailed: true,
    })
    expect(model.trendError).toBe(true)
  })

  it('refuses to plot a rate above 100% as a measurement', () => {
    // The 333%/450% autoresponder artefact. If a chart ever drew this, the
    // whole project would have failed at its own stated purpose.
    const broken: CampaignList = {
      ...campaigns,
      campaigns: [{ ...campaigns.campaigns[0], reply_rate: 4.5 }],
    }
    const model = buildShellModel({ overview, campaigns: broken, trend: null, freshness })
    expect(model.unreliableReplyRate).toBe(true)
  })

  it('extracts the trend series from the trend endpoint in day order', () => {
    const trend: CampaignTrend = {
      id: 'c1',
      external_id: 'e1',
      name: 'PB Signups / Leads',
      status: 'active',
      created_at: '2026-09-01',
      range: '30d',
      trend: [
        { metric_date: '2026-09-28', emails_sent: 100, replies_human: 5, replies_autoresponder: 0, bounces: 0, opportunities: 1, reply_rate: 0.05, bounce_rate: 0, open_rate: null, unsubscribe: null },
        { metric_date: '2026-09-29', emails_sent: 140, replies_human: 7, replies_autoresponder: 1, bounces: 1, opportunities: 2, reply_rate: 0.05, bounce_rate: 0.0071, open_rate: null, unsubscribe: null },
      ],
    }
    const model = buildShellModel({ overview, campaigns, trend, freshness })
    expect(model.trend).toEqual([
      { day: '2026-09-28', value: 100 },
      { day: '2026-09-29', value: 140 },
    ])
  })

  it('keeps a null trend day as null rather than plotting it as zero', () => {
    // A day the collector did not report is a gap. Plotting it as zero would
    // draw a crash that never happened.
    const trend: CampaignTrend = {
      id: 'c1',
      external_id: 'e1',
      name: 'x',
      status: null,
      created_at: null,
      range: '30d',
      trend: [
        { metric_date: '2026-09-28', emails_sent: 100, replies_human: 5, replies_autoresponder: 0, bounces: 0, opportunities: 1, reply_rate: 0.05, bounce_rate: 0, open_rate: null, unsubscribe: null },
        { metric_date: '2026-09-29', emails_sent: null, replies_human: null, replies_autoresponder: null, bounces: null, opportunities: null, reply_rate: null, bounce_rate: null, open_rate: null, unsubscribe: null },
      ],
    }
    const model = buildShellModel({ overview, campaigns, trend, freshness })
    expect(model.trend[1].value).toBeNull()
  })

  it('carries the collection-failed flag to the freshness line', () => {
    const failed = buildShellModel({
      overview,
      campaigns,
      trend: null,
      freshness: { generatedAt: null, collectionFailed: true },
    })
    expect(failed.freshness.collectionFailed).toBe(true)
    expect(failed.freshness.generatedAt).toBeNull()
  })

  it('reports a missing overview as unavailable rather than as zeros', () => {
    // An absent overview must be distinguishable from an overview of all
    // nulls: the page shows a plain "something went wrong" band for one and a
    // dash-filled KPI row for the other, because a failed fetch and an
    // unreported metric are different facts.
    const missing = buildShellModel({
      overview: null,
      campaigns: null,
      trend: null,
      freshness: { generatedAt: null, collectionFailed: true },
    })
    expect(missing.overviewUnavailable).toBe(true)
    expect(missing.kpis.every((k) => k.value === null)).toBe(true)

    const present = buildShellModel({
      overview,
      campaigns,
      trend: null,
      freshness: { generatedAt: null, collectionFailed: false },
    })
    expect(present.overviewUnavailable).toBe(false)
  })
})
