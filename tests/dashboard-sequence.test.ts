import { describe, expect, it } from 'vitest'
import { delayDays, sendDays, sequencePlan } from '@/lib/dashboard/sequence'
import type { ApiCampaign, ApiDailyRow } from '@/lib/instantly/types'
import type { StepStat } from '@/lib/dashboard/types'

const campaign: ApiCampaign = {
  id: 'c1',
  sequences: [{
    steps: [
      { delay: 2, variants: [{ subject: 'rewards cards at {{companyName}}' }, { subject: 'who pays?' }] },
      { delay: 3, variants: [{ subject: '' }] },
      { delay: 2, variants: [{ subject: 'quick follow up', v_disabled: false }] },
    ],
  }],
}

const stat = (step: number, variant: string, sent: number | null): StepStat => ({
  step, variant, subject: null, sent, opened: null, replied: 0, positive: null, replyRate: null,
})

describe('delayDays', () => {
  it('reads days by default and converts hours and minutes', () => {
    expect(delayDays({ delay: 2 })).toBe(2)
    expect(delayDays({ delay: 48, delay_unit: 'hours' })).toBe(2)
    expect(delayDays({ delay: 1440, delay_unit: 'minutes' })).toBe(1)
    expect(delayDays(undefined)).toBe(0)
    expect(delayDays({ delay: -3 })).toBe(0)
  })
})

describe('sendDays', () => {
  it('merges by date, drops empty days, sorts oldest first', () => {
    const rows: ApiDailyRow[] = [
      { date: '2026-10-05', sent: 10, new_leads_contacted: 10 },
      { date: '2026-10-03', sent: 0, new_leads_contacted: 0 },
      { date: '2026-10-01', sent: 5, new_leads_contacted: 5 },
      { date: '2026-10-07', sent: 4 },
    ]
    expect(sendDays(rows)).toEqual([
      { date: '2026-10-01', sent: 5, newLeads: 5 },
      { date: '2026-10-05', sent: 10, newLeads: 10 },
      { date: '2026-10-07', sent: 4, newLeads: 0 },
    ])
  })
  it('null when the daily call failed', () => {
    expect(sendDays(null)).toBeNull()
  })
})

describe('sequencePlan', () => {
  const daily: ApiDailyRow[] = [
    { date: '2026-10-01', sent: 5, new_leads_contacted: 5 },
    { date: '2026-10-03', sent: 5, new_leads_contacted: 0 },
    { date: '2026-10-09', sent: 7, new_leads_contacted: 7 },
  ]

  it('lists every step, including ones that have not sent yet, with day offsets and dates', () => {
    const p = sequencePlan(campaign, [stat(1, 'A', 8), stat(1, 'B', 4), stat(2, 'A', 5)], daily, '2026-10-11')
    expect(p.steps.map((s) => [s.step, s.dayOffset, s.sent, s.status])).toEqual([
      [1, 0, 12, 'sent'],
      [2, 2, 5, 'sent'],
      [3, 5, 0, 'upcoming'],
    ])
    // Step 2 went out 2 days after the first leads (Oct 1 -> Oct 3); next batch Oct 9 -> Oct 11.
    expect(p.steps[1]).toMatchObject({ firstDate: '2026-10-03', nextDate: '2026-10-11', subject: null })
    // Step 3 is upcoming: Oct 1 + 5 = Oct 6 (late/unsent), next Oct 9 + 5 = Oct 14.
    expect(p.steps[2]).toMatchObject({ firstDate: '2026-10-06', nextDate: '2026-10-14', subject: 'quick follow up' })
    expect(p.steps[0]).toMatchObject({ subject: 'rewards cards at {{companyName}}', variants: 2, nextDate: null })
    expect(p.days?.map((d) => [d.date, d.newLeads])).toEqual([['2026-10-01', 5], ['2026-10-03', 0], ['2026-10-09', 7]])
  })

  it('a campaign that has not started shows its steps with no dates', () => {
    const p = sequencePlan(campaign, [], [], '2026-10-11')
    expect(p.steps).toHaveLength(3)
    expect(p.steps.every((s) => s.status === 'upcoming' && s.firstDate === null && s.nextDate === null)).toBe(true)
    expect(p.steps.every((s) => s.sent === null)).toBe(true)
    expect(p.days).toEqual([])
  })

  it('keeps step results even when the sequence was not listed, and dates are null without daily data', () => {
    const p = sequencePlan(undefined, [stat(1, 'A', 3), stat(2, 'A', 1)], null, '2026-10-11')
    expect(p.steps.map((s) => [s.step, s.sent, s.dayOffset])).toEqual([[1, 3, 0], [2, 1, 0]])
    expect(p.days).toBeNull()
  })

  it('skips disabled variants for the subject', () => {
    const c: ApiCampaign = { id: 'x', sequences: [{ steps: [{ delay: 1, variants: [{ subject: 'old', v_disabled: true }, { subject: 'new' }] }] }] }
    expect(sequencePlan(c, [], null, '2026-10-11').steps[0]).toMatchObject({ subject: 'new', variants: 1 })
  })
})
