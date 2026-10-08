import { describe, expect, it } from 'vitest'
import { leadInsights, waitingDays } from '@/lib/insights/leads'
import { GENERATED_AT, input, lead } from '../fixtures/insights/builders'

describe('replies waiting on you', () => {
  it('interested lead waiting 3+ days is critical and names person + company', () => {
    const r = leadInsights(input({ repliedLeads: [
      lead('dana@acme.test', { name: 'Dana Lee', company: 'Acme', daysWaiting: 3.4, campaignName: 'Retail', lastReplyAt: '2026-10-05T14:00:00Z', lastReplySnippet: 'Sounds interesting,   can you send pricing?' }),
    ] }))
    expect(r).toHaveLength(1)
    expect(r[0].severity).toBe('critical')
    expect(r[0].title).toBe('Reply to Dana Lee at Acme, waiting 3 days')
    expect(r[0].detail).toBe('Marked "interested" in Instantly (“Retail”). Replied Oct 5: “Sounds interesting, can you send pricing?”. Our last email to them is older than their reply.')
    expect(r[0].action).toBe('Reply to Dana today and offer two specific call times.')
    expect(r[0].entity).toEqual({ kind: 'lead', id: 'dana@acme.test', name: 'Dana Lee' })
  })

  it('severity by wait: <1 day opportunity, 1-3 warning', () => {
    const r = leadInsights(input({ repliedLeads: [lead('a@t.test', { daysWaiting: 0.5 }), lead('b@t.test', { daysWaiting: 1.5 })] }))
    expect(r.find((i) => i.id === 'lead-waiting:a@t.test')!.severity).toBe('opportunity')
    expect(r.find((i) => i.id === 'lead-waiting:b@t.test')!.severity).toBe('warning')
  })

  it('oldest first; meeting labels get meeting actions', () => {
    const r = leadInsights(input({ repliedLeads: [
      lead('new@t.test', { daysWaiting: 1, interest: 'meeting_booked', name: 'Sam' }),
      lead('old@t.test', { daysWaiting: 5 }),
    ] }))
    expect(r.map((i) => i.id)).toEqual(['lead-waiting:old@t.test', 'lead-waiting:new@t.test'])
    expect(r[1].action).toBe('Confirm the meeting time with Sam today.')
  })

  it('computes the wait from generatedAt when the data layer gave none', () => {
    expect(waitingDays(lead('x@t.test', { lastReplyAt: '2026-10-06T16:00:00.000Z' }), GENERATED_AT)).toBe(2)
    expect(waitingDays(lead('x@t.test', {}), GENERATED_AT)).toBeNull()
    const r = leadInsights(input({ repliedLeads: [lead('x@t.test', {})] }))
    expect(r[0].title).toBe('Reply to x@t.test')
    expect(r[0].detail).toContain('Reply time not reported')
  })

  it('ignores leads we already answered and non-hot labels', () => {
    const r = leadInsights(input({ repliedLeads: [
      lead('a@t.test', { awaitingOurReply: false, daysWaiting: 9 }),
      lead('b@t.test', { interest: 'not_interested', daysWaiting: 9 }),
      lead('c@t.test', { interest: 'out_of_office', daysWaiting: 9 }),
    ] }))
    expect(r).toEqual([])
  })

  it('more than 5 hot leads: 5 cards plus one roll-up', () => {
    const leads = Array.from({ length: 8 }, (_, i) => lead(`l${i}@t.test`, { daysWaiting: i, name: `Lead ${i}` }))
    const r = leadInsights(input({ repliedLeads: leads }))
    expect(r.filter((i) => i.id.startsWith('lead-waiting:'))).toHaveLength(5)
    const more = r.find((i) => i.id === 'leads-waiting-more')!
    expect(more.title).toBe('3 more interested leads are waiting on a reply')
    expect(more.detail).toBe('Lead 2 (2 days); Lead 1 (1 day); Lead 0 (under a day).')
  })

  it('unlabeled replies waiting roll into one opportunity', () => {
    const r = leadInsights(input({ repliedLeads: [lead('u1@t.test', { interest: 'unlabeled' }), lead('u2@t.test', { interest: 'unlabeled', daysWaiting: 2 })] }))
    expect(r).toHaveLength(1)
    expect(r[0].id).toBe('replies-unlabeled')
    expect(r[0].title).toBe('2 replies are unlabeled and unanswered')
    expect(r[0].detail.startsWith('u2@t.test (2 days); u1@t.test')).toBe(true)
  })
})
