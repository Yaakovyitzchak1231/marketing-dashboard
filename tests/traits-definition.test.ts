import { describe, it, expect } from 'vitest'
import { validateTraitDefinition, TraitDefinitionError, validateTraitKey } from '@/lib/traits/definition'

describe('trait definition validator', () => {
  it('accepts a minimal count definition', () => {
    const def = validateTraitDefinition({ event_types: ['reply_received'], aggregation: 'count' })
    expect(def.aggregation).toBe('count')
    expect(def.event_types).toEqual(['reply_received'])
    expect(def.prop).toBeNull()
    expect(def.window_days).toBeNull()
  })

  it('accepts a single event_type string (not just an array)', () => {
    const def = validateTraitDefinition({ event_type: 'email_opened', aggregation: 'count', window_days: 14 })
    expect(def.event_types).toEqual(['email_opened'])
    expect(def.window_days).toBe(14)
  })

  it('rejects an unknown aggregation', () => {
    expect(() => validateTraitDefinition({ event_types: ['reply_received'], aggregation: 'median' })).toThrow(TraitDefinitionError)
  })

  it('requires prop for sum/min/max/last', () => {
    expect(() => validateTraitDefinition({ event_types: ['meeting_booked'], aggregation: 'sum' })).toThrow(TraitDefinitionError)
    const def = validateTraitDefinition({ event_types: ['meeting_booked'], aggregation: 'sum', prop: 'minutes' })
    expect(def.prop).toBe('minutes')
  })

  it('does not require prop for count/days_since', () => {
    expect(() => validateTraitDefinition({ event_types: ['reply_received'], aggregation: 'days_since' })).not.toThrow()
  })

  it('rejects empty event_types', () => {
    expect(() => validateTraitDefinition({ event_types: [], aggregation: 'count' })).toThrow(TraitDefinitionError)
  })

  it('rejects a badly-shaped event type key', () => {
    expect(() => validateTraitDefinition({ event_types: ['Not Valid!'], aggregation: 'count' })).toThrow(TraitDefinitionError)
  })

  it('rejects window_days out of range', () => {
    expect(() => validateTraitDefinition({ event_types: ['reply_received'], aggregation: 'count', window_days: 0 })).toThrow(TraitDefinitionError)
    expect(() => validateTraitDefinition({ event_types: ['reply_received'], aggregation: 'count', window_days: -5 })).toThrow(TraitDefinitionError)
  })

  it('validates prop_filters shape', () => {
    const def = validateTraitDefinition({
      event_types: ['email_link_clicked'],
      aggregation: 'count',
      prop_filters: [{ path: 'url', op: 'contains', value: '/pricing' }],
    })
    expect(def.prop_filters).toEqual([{ path: 'url', op: 'contains', value: '/pricing' }])
    expect(() => validateTraitDefinition({ event_types: ['x'], aggregation: 'count', prop_filters: [{ path: 'url', op: 'bogus', value: 'x' }] })).toThrow(TraitDefinitionError)
  })

  it('trait keys are lowercase slugs', () => {
    expect(validateTraitKey('replies_30d')).toBe('replies_30d')
    expect(() => validateTraitKey('Replies 30d')).toThrow(TraitDefinitionError)
    expect(() => validateTraitKey('')).toThrow(TraitDefinitionError)
  })
})
