import { describe, expect, it } from 'vitest'
import { classifyAccountHealth } from '@/lib/insights'
import { statusKind } from '@/lib/insights/accounts'
import { BOUNCE_CRITICAL, BOUNCE_WARN, MIN_SENT_FOR_ACCOUNT_BOUNCE, WARMUP_AT_RISK, WARMUP_WATCH } from '@/lib/insights/thresholds'
import { account } from '../fixtures/insights/builders'

const strip = ({ health: _h, healthReason: _r, ...rest }: ReturnType<typeof account>) => rest

describe('thresholds are what the docs say', () => {
  it('bounce 2% warn / 5% critical, warmup 90 / 70', () => {
    expect(BOUNCE_WARN).toBe(0.02)
    expect(BOUNCE_CRITICAL).toBe(0.05)
    expect(WARMUP_WATCH).toBe(90)
    expect(WARMUP_AT_RISK).toBe(70)
  })
})

describe('classifyAccountHealth', () => {
  it('healthy with low bounce and good warmup, reason carries the numbers', () => {
    const r = classifyAccountHealth(strip(account('a@x.com', { sent: 400, bounced: 3, warmupScore: 98 })))
    expect(r.health).toBe('healthy')
    expect(r.healthReason).toBe('0.75% bounce (3 of 400 sent), warmup 98')
  })

  it('exactly 2% is not over the target; just above is watch', () => {
    expect(classifyAccountHealth(strip(account('a@x.com', { sent: 100, bounced: 2, warmupScore: 100 }))).health).toBe('healthy')
    const r = classifyAccountHealth(strip(account('a@x.com', { sent: 100, bounced: 3, warmupScore: 100 })))
    expect(r.health).toBe('watch')
    expect(r.healthReason).toContain('3% bounce (3 of 100 sent), over the 2% target')
  })

  it('over 5% is at risk', () => {
    const r = classifyAccountHealth(strip(account('a@x.com', { sent: 180, bounced: 11 })))
    expect(r.health).toBe('at_risk')
    expect(r.healthReason).toContain('6.1% bounce (11 of 180 sent), over the 5% limit')
  })

  it('does not judge bounce under the minimum sends', () => {
    const r = classifyAccountHealth(strip(account('a@x.com', { sent: MIN_SENT_FOR_ACCOUNT_BOUNCE - 1, bounced: 10 })))
    expect(r.health).toBe('unknown')
    expect(r.healthReason).toContain('too few to judge')
  })

  it('warmup thresholds', () => {
    expect(classifyAccountHealth(strip(account('a@x.com', { warmupScore: 85 }))).health).toBe('watch')
    expect(classifyAccountHealth(strip(account('a@x.com', { warmupScore: 60 }))).health).toBe('at_risk')
    expect(classifyAccountHealth(strip(account('a@x.com', { warmupScore: 90 }))).health).toBe('healthy')
  })

  it('error statuses (word or Instantly numeric code) are at risk', () => {
    for (const s of ['error', 'connection_error', 'Sending error', '-1', '-2', 'disconnected']) {
      const r = classifyAccountHealth(strip(account('a@x.com', { status: s, sent: 500, bounced: 0, warmupScore: 100 })))
      expect(r.health, s).toBe('at_risk')
      expect(r.healthReason).toContain(`"${s}"`)
    }
  })

  it('paused is watch', () => {
    expect(classifyAccountHealth(strip(account('a@x.com', { status: 'paused', warmupScore: 100 }))).health).toBe('watch')
    expect(statusKind('2')).toBe('paused')
    expect(statusKind('1')).toBe('active')
    expect(statusKind('inactive')).toBe('paused')
  })

  it('lists every problem, worst first', () => {
    const r = classifyAccountHealth(strip(account('a@x.com', { sent: 100, bounced: 3, warmupScore: 50 })))
    expect(r.health).toBe('at_risk')
    expect(r.healthReason.indexOf('warmup')).toBeLessThan(r.healthReason.indexOf('bounce'))
  })

  it('nothing to judge -> unknown, never healthy', () => {
    expect(classifyAccountHealth(strip(account('a@x.com', {}))).health).toBe('unknown')
    expect(classifyAccountHealth(strip(account('a@x.com', { sent: 0 }))).health).toBe('unknown')
  })

  it('uses Instantly bounceRate only when bounced count is missing and the rate is real', () => {
    expect(classifyAccountHealth(strip(account('a@x.com', { sent: 200, bounced: null, bounceRate: 0.07 }))).health).toBe('at_risk')
    expect(classifyAccountHealth(strip(account('a@x.com', { sent: 200, bounced: null, bounceRate: 4.5 }))).health).toBe('unknown')
  })
})
