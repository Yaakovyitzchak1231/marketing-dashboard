import { describe, expect, it } from 'vitest'
import { campaignInsights, eligibleCampaigns, pickBest, pickWorst } from '@/lib/insights/campaigns'
import { campaign, input } from '../fixtures/insights/builders'
import { realShaped30d } from '../fixtures/insights/real-shaped-30d'

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('small-sample guard', () => {
  it('a campaign under 100 leads contacted is never ranked', () => {
    const cs = [campaign('lucky', { counts: { contacted: 5, replied: 2 } }), campaign('big', { counts: { contacted: 1000, replied: 40 } })]
    expect(eligibleCampaigns(cs, 'replied').map((s) => s.c.id)).toEqual(['big'])
    const r = campaignInsights(input({ campaigns: cs }))
    expect(ids(r).some((i) => i.startsWith('campaign-best'))).toBe(false)
    const early = r.find((i) => i.id === 'campaigns-too-early')!
    expect(early.detail).toContain('“Campaign lucky” (5)')
  })

  it('ranks by the Wilson lower bound, not the raw rate', () => {
    // 30/100 = 30% (lower ~21.9%) vs 250/1000 = 25% (lower ~22.4%): the bigger one is the safer bet.
    const cs = [campaign('small', { counts: { contacted: 100, replied: 30 } }), campaign('large', { counts: { contacted: 1000, replied: 250 } })]
    expect(pickBest(eligibleCampaigns(cs, 'replied'))!.c.id).toBe('large')
  })

  it('ties are broken deterministically', () => {
    const cs = [campaign('b', { counts: { contacted: 200, replied: 10 } }), campaign('a', { counts: { contacted: 200, replied: 10 } })]
    expect(pickBest(eligibleCampaigns(cs, 'replied'))!.c.id).toBe('a')
    expect(pickWorst(eligibleCampaigns(cs, 'replied'))!.c.id).toBe('a')
  })

  it('null counts are skipped, not treated as 0', () => {
    const cs = [campaign('n', { counts: { contacted: null, replied: 5 } }), campaign('m', { counts: { contacted: 500, replied: null } })]
    expect(eligibleCampaigns(cs, 'replied')).toEqual([])
    expect(campaignInsights(input({ campaigns: cs }))).toEqual([])
  })
})

describe('best / worst', () => {
  const cs = [
    campaign('good', { name: 'Good', counts: { contacted: 1000, replied: 60, positive: 30, autoReplies: 4 } }),
    campaign('bad', { name: 'Bad', counts: { contacted: 1000, replied: 15, positive: 2 } }),
  ]
  it('a clear gap gives a gap card and a best card with the counts', () => {
    const r = campaignInsights(input({ campaigns: cs }))
    const gap = r.find((i) => i.id === 'campaign-gap:bad')!
    expect(gap.severity).toBe('opportunity')
    expect(gap.title).toBe('“Bad” replies at 1.5%, “Good” at 6%')
    expect(gap.detail).toContain('60 of 1,000')
    expect(gap.detail).toContain('60 of 1,000 leads; 4 auto-replies not counted')
    const best = r.find((i) => i.id === 'campaign-best:good')!
    expect(best.severity).toBe('win')
    const pos = r.find((i) => i.id === 'campaign-best-positive:good')!
    expect(pos.detail).toContain('30 of 1,000')
    expect(pos.detail).toContain('50% of its 60 replies')
  })
  it('overlapping intervals: no ranking claim at all', () => {
    const r = campaignInsights(input({ campaigns: [
      campaign('x', { counts: { contacted: 200, replied: 10 } }),
      campaign('y', { counts: { contacted: 200, replied: 7 } }),
    ] }))
    expect(ids(r).filter((i) => i.startsWith('campaign-gap') || i.startsWith('campaign-best:'))).toEqual([])
  })
  it('one eligible campaign is never called "best"', () => {
    const r = campaignInsights(input({ campaigns: [campaign('x', { counts: { contacted: 900, replied: 50 } })] }))
    expect(ids(r).some((i) => i.startsWith('campaign-best'))).toBe(false)
  })
})

describe('vs his own history (lifetime)', () => {
  it('real 30d shape: the sending campaign is compared with the pooled past, not an average of rates', () => {
    const r = campaignInsights(realShaped30d)
    const c = r.find((i) => i.id === 'campaign-vs-history:c-test')!
    expect(c.severity).toBe('warning')
    // others pooled: (1357+143+260+0) / (11746+4377+515+210) = 1760 / 16848
    expect(c.detail).toContain('1,760 of 16,848 replied (10.4%)')
    expect(c.detail).toContain('10 of 495 leads replied (plus 11 auto-replies, not counted)')
    expect(c.detail).toContain('Best ever: “Qualified”')
    expect(c.title).toBe('“Retailers - Test 01” replies at 2%, vs 10.4% across your past campaigns')
  })
  it('no "best campaign" win for a campaign flagged below history', () => {
    expect(ids(campaignInsights(realShaped30d)).some((i) => i.startsWith('campaign-best'))).toBe(false)
  })
  it('stopped winners: completed campaigns with real results that sent nothing this period', () => {
    const c = campaignInsights(realShaped30d).find((i) => i.id === 'campaigns-stopped-winners')!
    expect(c.title).toBe('3 campaigns that produced 1,263 opportunities are not sending')
    expect(c.detail).toContain('“Signups / Leads” (completed; 1,357 replies, 951 opportunities, 11.6% reply rate)')
    expect(c.detail).toContain('Only 2 campaigns are sending now')
    expect(c.action).toContain('Relaunch “Signups / Leads”')
  })
  it('is a warning when at most one campaign is sending', () => {
    const d = { ...realShaped30d, campaigns: realShaped30d.campaigns.filter((c) => c.id !== 'c-seg3') }
    expect(campaignInsights(d).find((i) => i.id === 'campaigns-stopped-winners')!.severity).toBe('warning')
  })
  it('skipped on the all-time range (range already is lifetime) and when lifetime is absent', () => {
    const all = { ...realShaped30d, range: { ...realShaped30d.range, key: 'all' as const, start: null } }
    expect(ids(campaignInsights(all)).filter((i) => i.startsWith('campaign-vs-history') || i === 'campaigns-stopped-winners')).toEqual([])
    const noLife = { ...realShaped30d, campaigns: realShaped30d.campaigns.map(({ lifetime: _l, ...c }) => c) }
    expect(ids(campaignInsights(noLife)).filter((i) => i.startsWith('campaign-vs-history') || i === 'campaigns-stopped-winners')).toEqual([])
  })
  it('not flagged when this period is in line with history', () => {
    const d = input({ campaigns: [
      campaign('now', { counts: { contacted: 500, replied: 50 }, lifetime: { contacted: 500, replied: 50 } }),
      campaign('old', { status: 'completed', counts: { contacted: 0, replied: 0, sent: 0 }, lifetime: { contacted: 2000, replied: 210 } }),
    ] })
    expect(ids(campaignInsights(d)).some((i) => i.startsWith('campaign-vs-history'))).toBe(false)
  })
})

describe('zero replies', () => {
  it('fires at 150+ contacted with 0 replies, with the lag caveat; real-shaped launch campaign', () => {
    const c = campaignInsights(realShaped30d).find((i) => i.id === 'campaign-zero-replies:c-seg3')!
    expect(c.severity).toBe('warning')
    expect(c.detail).toContain('0 of 210')
    expect(c.detail).toContain('lag')
    // and it is not ALSO compared against history (one card per problem)
    expect(ids(campaignInsights(realShaped30d))).not.toContain('campaign-vs-history:c-seg3')
  })
  it('silent under 150 contacted or when replies are unknown', () => {
    expect(campaignInsights(input({ campaigns: [campaign('a', { counts: { contacted: 149, replied: 0 } })] }))
      .some((i) => i.id.startsWith('campaign-zero'))).toBe(false)
    expect(campaignInsights(input({ campaigns: [campaign('a', { counts: { contacted: 500, replied: null } })] }))).toEqual([])
  })
})

describe('lifecycle', () => {
  it('error campaign is critical', () => {
    const r = campaignInsights(input({ campaigns: [campaign('e', { status: 'error', leadsRemaining: 300 })] }))
    const c = r.find((i) => i.id === 'campaign-error:e')!
    expect(c.severity).toBe('critical')
    expect(c.detail).toContain('300 leads are still waiting')
  })
  it('active with 0 leads left is a warning; paused with 0 is not', () => {
    const r = campaignInsights(input({ campaigns: [
      campaign('dry', { status: 'active', leadsRemaining: 0, leadsTotal: 495 }),
      campaign('p', { status: 'paused', leadsRemaining: 0 }),
    ] }))
    expect(r.find((i) => i.id === 'campaign-out-of-leads:dry')!.detail).toContain('out of 495')
    expect(ids(r)).not.toContain('campaign-out-of-leads:p')
  })
  it('low runway from this period pace', () => {
    // 300 contacted over 30 days = 10/day; 30 left = 3 days
    const r = campaignInsights(input({ campaigns: [campaign('r', { counts: { contacted: 300, replied: 20 }, leadsRemaining: 30 })] }))
    const c = r.find((i) => i.id === 'campaign-low-runway:r')!
    expect(c.title).toContain('about 3 days')
    expect(c.detail).toContain('10.0 a day')
    // 10 days of runway: silent
    expect(ids(campaignInsights(input({ campaigns: [campaign('r', { counts: { contacted: 300 }, leadsRemaining: 100 })] })))).not.toContain('campaign-low-runway:r')
  })
  it('campaign that finished during the period', () => {
    const r = campaignInsights(input({ campaigns: [campaign('f', { status: 'completed', counts: { sent: 400, contacted: 120, replied: 9, positive: 3 } })] }))
    expect(r.find((i) => i.id === 'campaigns-completed')!.detail).toContain('9 replies, 3 opportunities')
  })
  it('a completed campaign with no activity this period is not "finished this period"', () => {
    const r = campaignInsights(input({ campaigns: [campaign('f', { status: 'completed', counts: { sent: 0, contacted: 0 } })] }))
    expect(ids(r)).not.toContain('campaigns-completed')
  })
})

describe('one card per problem', () => {
  it('a zero-reply campaign is never also the "worst" in the gap card', () => {
    const r = campaignInsights(input({ campaigns: [
      campaign('good', { name: 'Good', counts: { contacted: 1000, replied: 80 } }),
      campaign('meh', { name: 'Meh', counts: { contacted: 1000, replied: 20 } }),
      campaign('zero', { name: 'Zero', counts: { contacted: 300, replied: 0 } }),
    ] }))
    expect(ids(r)).toContain('campaign-zero-replies:zero')
    expect(ids(r)).toContain('campaign-gap:meh')
    expect(ids(r)).not.toContain('campaign-gap:zero')
  })
  it('all-time range: no "finished this period" card, and wording says full history', () => {
    const d = input({
      range: { key: 'all', start: null, end: '2026-10-08', timezone: 'America/New_York' },
      campaigns: [
        campaign('a', { name: 'A', status: 'completed', counts: { sent: 3000, contacted: 1000, replied: 90, autoReplies: 1 } }),
        campaign('b', { name: 'B', status: 'completed', counts: { sent: 3000, contacted: 1000, replied: 20 } }),
      ],
    })
    const r = campaignInsights(d)
    expect(ids(r)).not.toContain('campaigns-completed')
    const best = r.find((i) => i.id === 'campaign-best:a')!
    expect(best.detail).toContain('in your full history')
    expect(best.detail).toContain('(plus 1 auto-reply, not counted)')
  })
})
