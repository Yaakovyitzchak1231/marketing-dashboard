import { describe, it, expect } from 'vitest'
import { evaluateEvents, fitRulesFromProfile, isLive, parseRules, parseThresholds, sumScore, thresholdFor } from '@/lib/scoring/rules'

describe('scoring rules (pure)', () => {
  const rules = parseRules([
    { rule_key: 'replied', label: 'Replied', event_type: 'reply_received', points: 10 },
    { rule_key: 'opened', label: 'Opened', event_type: 'email_opened', points: 2, expires_after_days: 30 },
    { rule_key: 'bounced', label: 'Bounced', event_type: 'email_bounced', points: -20 },
  ])

  it('parseRules rejects malformed rules', () => {
    expect(() => parseRules([{ rule_key: 'x' }])).toThrow()
    expect(() => parseRules('nope' as never)).toThrow()
  })

  it('evaluateEvents fires one award per matching event, with expiry computed from occurred_at', () => {
    const base = new Date('2026-01-01T00:00:00Z')
    const awards = evaluateEvents(rules, [
      { id: 1, type: 'reply_received', occurred_at: base },
      { id: 2, type: 'email_opened', occurred_at: base },
      { id: 3, type: 'email_link_clicked', occurred_at: base }, // no matching rule
    ])
    expect(awards).toHaveLength(2)
    expect(awards[0]).toMatchObject({ rule_key: 'replied', points: 10, source_event_id: 1, expires_at: null })
    expect(awards[1].expires_at?.toISOString()).toBe('2026-01-31T00:00:00.000Z')
  })

  it('isLive / sumScore drop expired points from the total', () => {
    const now = new Date('2026-02-05T00:00:00Z')
    const points = [
      { points: 10, expires_at: null },
      { points: 2, expires_at: '2026-01-31T00:00:00.000Z' }, // expired by now
      { points: 5, expires_at: '2026-03-01T00:00:00.000Z' }, // still live
    ]
    expect(isLive(points[1].expires_at, now)).toBe(false)
    expect(sumScore(points, null, now)).toBe(15)
  })

  it('sumScore caps at max_points but never un-negatives a negative total', () => {
    expect(sumScore([{ points: 10, expires_at: null }, { points: 10, expires_at: null }], 15)).toBe(15)
    expect(sumScore([{ points: -20, expires_at: null }], 15)).toBe(-20)
  })

  it('thresholdFor picks the highest threshold met, or null', () => {
    const thresholds = parseThresholds([{ key: 'hot', label: 'Hot', min: 25 }, { key: 'warm', label: 'Warm', min: 10 }])
    expect(thresholdFor(30, thresholds)?.key).toBe('hot')
    expect(thresholdFor(15, thresholds)?.key).toBe('warm')
    expect(thresholdFor(5, thresholds)).toBeNull()
  })

  it('fitRulesFromProfile builds rules only from approved signal_rule items, nothing hard-coded', () => {
    const items = [
      { kind: 'signal_rule', name: 'Hiring a sales rep', value: null, config: { event_type: 'custom', signal_type: 'hiring', points: 8 }, status: 'approved' },
      { kind: 'signal_rule', name: 'Not yet approved', value: null, config: { points: 50 }, status: 'suggested' },
      { kind: 'competitor', name: 'Toast', value: 'toasttab.com', config: {}, status: 'approved' },
    ]
    const built = fitRulesFromProfile(items)
    expect(built).toHaveLength(1)
    expect(built[0]).toMatchObject({ label: 'Hiring a sales rep', event_type: 'custom', points: 8, props_match: { signal_type: 'hiring' } })
  })
})
