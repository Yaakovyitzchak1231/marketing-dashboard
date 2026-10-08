import { describe, expect, it } from 'vitest'
import { stepInsights } from '@/lib/insights/steps'
import { campaign, input, step } from '../fixtures/insights/builders'

const ids = (xs: { id: string }[]) => xs.map((x) => x.id)

describe('A/B variant winner', () => {
  it('significant winner with enough sends -> make it the default, quoting both subjects', () => {
    const c = campaign('c1', { name: 'Retail', steps: [
      step({ step: 1, variant: 'A', subject: 'quick question', sent: 1000, replied: 20 }),
      step({ step: 1, variant: 'B', subject: 'saw your store', sent: 1000, replied: 55 }),
    ] })
    const r = stepInsights(input({ campaigns: [c] }))
    const w = r.find((i) => i.id === 'variant-winner:c1:1')!
    expect(w.title).toBe('Make variant B the default for step 1 of “Retail”')
    expect(w.detail).toContain('“saw your store” got replies from 5.5% of sends (55 of 1,000)')
    expect(w.detail).toContain('variant A “quick question” got 2% (20 of 1,000)')
    expect(w.action).toContain('Turn off variant A on step 1')
    expect(w.entity).toEqual({ kind: 'step', id: 'c1:1:B', name: 'Retail: step 1 variant B' })
  })
  it('not significant -> no card', () => {
    // real-shaped step 3: 153/5594 vs 1/105 is not significant
    const c = campaign('c1', { steps: [
      step({ step: 3, variant: 'A', sent: 5594, replied: 153 }),
      step({ step: 3, variant: 'B', sent: 105, replied: 1 }),
    ] })
    expect(ids(stepInsights(input({ campaigns: [c] })))).not.toContain('variant-winner:c1:3')
  })
  it('a variant under 100 sends is never compared, however lopsided', () => {
    // real-shaped step 1: B 724/11692 vs A 1/54
    const c = campaign('c1', { steps: [
      step({ step: 1, variant: 'A', sent: 54, replied: 1 }),
      step({ step: 1, variant: 'B', sent: 11692, replied: 724 }),
    ] })
    expect(ids(stepInsights(input({ campaigns: [c] })))).not.toContain('variant-winner:c1:1')
  })
  it('null replies are not zero', () => {
    const c = campaign('c1', { steps: [
      step({ step: 1, variant: 'A', sent: 1000, replied: null }),
      step({ step: 1, variant: 'B', sent: 1000, replied: 60 }),
    ] })
    expect(stepInsights(input({ campaigns: [c] }))).toEqual([])
  })
})

describe('dead follow-up step', () => {
  it('step 2+ with 200+ sends and 0 replies', () => {
    const c = campaign('c1', { name: 'X', steps: [
      step({ step: 1, variant: 'A', sent: 500, replied: 8 }),
      step({ step: 4, variant: 'A', sent: 150, replied: 0 }),
      step({ step: 4, variant: 'B', sent: 120, replied: 0 }),
    ] })
    const d = stepInsights(input({ campaigns: [c] })).find((i) => i.id === 'step-dead:c1:4')!
    expect(d.title).toBe('Step 4 of “X” gets no replies')
    expect(d.detail).toContain('0 replies from 270 step-4 sends')
  })
  it('never for step 1, under 200 sends, or with unknown replies', () => {
    const c = campaign('c1', { steps: [
      step({ step: 1, variant: 'A', sent: 900, replied: 0 }),
      step({ step: 2, variant: 'A', sent: 199, replied: 0 }),
      step({ step: 3, variant: 'A', sent: 400, replied: null }),
    ] })
    expect(stepInsights(input({ campaigns: [c] })).filter((i) => i.id.startsWith('step-dead'))).toEqual([])
  })
})

describe('where replies come from', () => {
  it('real-shaped lifetime mix: follow-ups earn ~46% -> keep them (win)', () => {
    const c = campaign('pb', { steps: [
      step({ step: 1, variant: 'A', sent: 54, replied: 1 }),
      step({ step: 1, variant: 'B', sent: 11692, replied: 724 }),
      step({ step: 2, variant: 'A', sent: 10208, replied: 384 }),
      step({ step: 2, variant: 'B', sent: 74, replied: 1 }),
      step({ step: 3, variant: 'A', sent: 5594, replied: 153 }),
      step({ step: 3, variant: 'B', sent: 105, replied: 1 }),
      step({ step: 4, variant: 'A', sent: 126, replied: 2 }),
      step({ step: 4, variant: 'B', sent: 4040, replied: 87 }),
    ] })
    const m = stepInsights(input({ campaigns: [c] })).find((i) => i.id === 'step-mix')!
    expect(m.severity).toBe('win')
    expect(m.title).toBe('Follow-ups earn 46.4% of your replies')
    expect(m.detail).toContain('1,353 total')
    expect(m.detail).toContain('step 1: 725 (53.6%), 6.2% of its 11,746 sends')
    expect(m.action).toContain('Keep the follow-ups')
  })
  it('step-1 dominant -> opportunity to focus on step 1', () => {
    const c = campaign('c', { steps: [
      step({ step: 1, variant: 'A', sent: 1000, replied: 40 }),
      step({ step: 2, variant: 'A', sent: 900, replied: 5 }),
    ] })
    const m = stepInsights(input({ campaigns: [c] })).find((i) => i.id === 'step-mix')!
    expect(m.severity).toBe('opportunity')
    expect(m.title).toBe('Step 1 earns 88.9% of your replies')
  })
  it('needs 20 replies', () => {
    const c = campaign('c', { steps: [step({ step: 1, variant: 'A', sent: 495, replied: 7 }), step({ step: 2, variant: 'A', sent: 490, replied: 2 })] })
    expect(ids(stepInsights(input({ campaigns: [c] })))).not.toContain('step-mix')
  })
})

describe('best subject line', () => {
  it('picks by Wilson lower bound across campaigns, needs 2+ distinct subjects', () => {
    const r = stepInsights(input({ campaigns: [
      campaign('a', { name: 'A', steps: [step({ step: 1, variant: 'A', subject: 'tiny lucky', sent: 100, replied: 9 })] }),
      campaign('b', { name: 'B', steps: [step({ step: 1, variant: 'B', subject: 'proven', sent: 3000, replied: 240 })] }),
    ] }))
    const s = r.find((i) => i.id.startsWith('subject-best'))!
    expect(s.title).toBe('Best subject line: “proven”')
    expect(s.detail).toContain('240 of 3,000')
    expect(s.detail).toContain('step 1, variant B of “B”')
  })
  it('one subject only, or subjects with too few sends -> nothing', () => {
    expect(stepInsights(input({ campaigns: [campaign('a', { steps: [step({ step: 1, variant: 'A', subject: 'x', sent: 900, replied: 30 })] })] }))
      .some((i) => i.id.startsWith('subject-best'))).toBe(false)
    expect(stepInsights(input({ campaigns: [campaign('a', { steps: [
      step({ step: 1, variant: 'A', subject: 'x', sent: 99, replied: 30 }),
      step({ step: 1, variant: 'B', subject: 'y', sent: 99, replied: 3 }),
    ] })] })).some((i) => i.id.startsWith('subject-best'))).toBe(false)
  })
  it('empty steps (step analytics failed) -> nothing, no crash', () => {
    expect(stepInsights(input({ campaigns: [campaign('a', { steps: [] })] }))).toEqual([])
  })
})
