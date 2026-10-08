import { describe, expect, it } from 'vitest'
import { deliverabilityInsights } from '@/lib/insights/accounts'
import { account, input, totals } from '../fixtures/insights/builders'

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('workspace bounce rate', () => {
  it('warning above 2%', () => {
    const r = deliverabilityInsights(input({ totals: totals({ sent: 1000, bounced: 30 }) }))
    const card = r.find((i) => i.id === 'bounce-total')!
    expect(card.severity).toBe('warning')
    expect(card.detail).toContain('30 of 1,000')
    expect(card.title).toContain('3%')
  })
  it('critical above 5%', () => {
    const r = deliverabilityInsights(input({ totals: totals({ sent: 1000, bounced: 60 }) }))
    expect(r.find((i) => i.id === 'bounce-total')!.severity).toBe('critical')
  })
  it('silent at or below 2%, or with too few sends, or when bounced is unknown', () => {
    expect(ids(deliverabilityInsights(input({ totals: totals({ sent: 1000, bounced: 20 }) })))).not.toContain('bounce-total')
    expect(ids(deliverabilityInsights(input({ totals: totals({ sent: 40, bounced: 10 }) })))).not.toContain('bounce-total')
    expect(ids(deliverabilityInsights(input({ totals: totals({ sent: 1000, bounced: null }) })))).not.toContain('bounce-total')
  })
  it('real 30d shape (6 of 2,618 = 0.23%) is silent', () => {
    expect(deliverabilityInsights(input({ totals: totals({ sent: 2618, bounced: 6 }) }))).toEqual([])
  })
})

describe('per-account findings', () => {
  it('one bad account gets its own named card', () => {
    const r = deliverabilityInsights(input({
      accounts: [account('bad@x.com', { sent: 200, bounced: 14 }), account('ok@x.com', { sent: 200, bounced: 1 })],
    }))
    const c = r.find((i) => i.id === 'bounce-at_risk:bad@x.com')!
    expect(c.severity).toBe('critical')
    expect(c.entity).toEqual({ kind: 'account', id: 'bad@x.com', name: 'bad@x.com' })
    expect(c.detail).toContain('7% bounce (14 of 200 sent)')
  })

  it('many bad accounts roll into one card, worst first', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        account('a@x.com', { sent: 100, bounced: 3 }),
        account('b@x.com', { sent: 100, bounced: 4 }),
        account('c@x.com', { sent: 100, bounced: 1 }),
      ],
    }))
    const c = r.find((i) => i.id === 'bounce-watch')!
    expect(c.severity).toBe('warning')
    expect(c.title).toBe('2 sending accounts bounce above 2%')
    expect(c.detail.indexOf('b@x.com')).toBeLessThan(c.detail.indexOf('a@x.com'))
    expect(c.entity).toBeUndefined()
  })

  it('error accounts are critical; paused is an opportunity; low warmup is flagged', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        account('e@x.com', { status: 'connection_error' }),
        account('p@x.com', { status: 'paused' }),
        account('w@x.com', { warmupScore: 55 }),
        account('w2@x.com', { warmupScore: 85 }),
      ],
    }))
    expect(r.find((i) => i.id === 'account-error:e@x.com')!.severity).toBe('critical')
    expect(r.find((i) => i.id === 'account-paused:p@x.com')!.severity).toBe('opportunity')
    expect(r.find((i) => i.id === 'warmup-at_risk:w@x.com')!.severity).toBe('warning')
    expect(r.find((i) => i.id === 'warmup-watch:w2@x.com')!.severity).toBe('opportunity')
  })

  it('healthy accounts produce nothing', () => {
    const r = deliverabilityInsights(input({
      accounts: [account('a@x.com', { sent: 1300, bounced: 3, warmupScore: 100 }), account('b@x.com', { sent: 1318, bounced: 3, warmupScore: 100 })],
    }))
    expect(r).toEqual([])
  })
})

describe('load balance', () => {
  it('flags an account sending 2x+ the median with real volume', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        account('a@x.com', { sent: 100, bounced: 0 }),
        account('b@x.com', { sent: 110, bounced: 0 }),
        account('c@x.com', { sent: 120, bounced: 0 }),
        account('heavy@x.com', { sent: 600, bounced: 0 }),
      ],
    }))
    const c = r.find((i) => i.id === 'load:heavy@x.com')!
    expect(c.severity).toBe('opportunity')
    expect(c.detail).toContain('600 sent')
    expect(c.detail).toContain('5.2x the median')
  })
  it('is a warning when the heavy account is also bouncing', () => {
    const r = deliverabilityInsights(input({
      accounts: [
        account('a@x.com', { sent: 100, bounced: 0 }),
        account('b@x.com', { sent: 110, bounced: 0 }),
        account('heavy@x.com', { sent: 600, bounced: 18 }),
      ],
    }))
    expect(r.find((i) => i.id === 'load:heavy@x.com')!.severity).toBe('warning')
  })
  it('needs at least 3 sending accounts and 100 sends', () => {
    expect(ids(deliverabilityInsights(input({ accounts: [account('a@x.com', { sent: 10 }), account('b@x.com', { sent: 900 })] })))).not.toContain('load:b@x.com')
    expect(ids(deliverabilityInsights(input({
      accounts: [account('a@x.com', { sent: 2 }), account('b@x.com', { sent: 3 }), account('c@x.com', { sent: 40 })],
    })))).not.toContain('load:c@x.com')
  })
})

describe('idle accounts', () => {
  it('active accounts with 0 sends while others send', () => {
    const r = deliverabilityInsights(input({
      accounts: [account('a@x.com', { sent: 300, bounced: 0 }), account('idle@x.com', { sent: 0, warmupScore: 100 })],
    }))
    const c = r.find((i) => i.id === 'accounts-idle')!
    expect(c.detail).toContain('idle@x.com (0 sent, warmup 100)')
  })
  it('silent when nobody sent (nothing to compare to) or sends are unknown', () => {
    expect(deliverabilityInsights(input({ accounts: [account('a@x.com', { sent: 0 }), account('b@x.com', { sent: null })] }))).toEqual([])
  })
})
