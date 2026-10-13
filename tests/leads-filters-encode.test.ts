import { describe, it, expect } from 'vitest'
import {
  parseLeadQuery, leadQueryToParams, leadsHref, activeFilterCount, defaultDir,
  encodeAdvancedFilter, decodeAdvancedFilter, parseSegParam, NONE,
} from '@/lib/leads/filters'

describe('Leads URL contract (plan 2.5): old params unaffected by the new ones', () => {
  it('round-trips every existing LeadFilters field exactly as before', () => {
    const q = parseLeadQuery({
      view: 'kanban', q: 'ring co', state: 'NY', stage: 'ready', segment: 'jeweler',
      verification: 'valid', email: 'yes', owner: 'no', job: '42', campaign: NONE,
      sort: 'name', dir: 'asc', page: '3',
    })
    expect(q).toMatchObject({
      view: 'kanban',
      filters: { q: 'ring co', state: 'NY', stage: 'ready', segment: 'jeweler', verification: 'valid', hasEmail: true, ownerKnown: false, job: 42, campaign: NONE },
      sort: 'name', dir: 'asc', page: 3,
    })
    const params = leadQueryToParams(q)
    const roundTripped = parseLeadQuery(Object.fromEntries(params))
    expect(roundTripped).toEqual(q)
  })

  it('round-trips the ready and touched filters the Overview tiles link to', () => {
    const q = parseLeadQuery({ ready: 'yes', touched: 'no' })
    expect(q.filters).toMatchObject({ ready: true, touched: false })
    expect(parseLeadQuery(Object.fromEntries(leadQueryToParams(q)))).toEqual(q)
    expect(activeFilterCount(q.filters)).toBe(2)
  })

  it('a bare old /leads URL (no seg, no f) still parses to zero active filters', () => {
    const q = parseLeadQuery({})
    expect(activeFilterCount(q.filters)).toBe(0)
    expect(leadsHref(q)).toBe('/leads')
    expect(defaultDir('updated')).toBe('desc')
  })

  it('companyIds never appears on LeadFilters from a URL, and never serializes back out', () => {
    const q = parseLeadQuery({ seg: '5', f: 'anything', state: 'NY' })
    expect(q.filters).not.toHaveProperty('companyIds')
    expect(leadQueryToParams(q).has('seg')).toBe(false)
    expect(leadQueryToParams(q).has('f')).toBe(false)
  })
})

describe('advanced filter params (plan 2.5): ?seg= and ?f=, independent of LeadFilters', () => {
  it('parseSegParam accepts a positive integer only', () => {
    expect(parseSegParam('42')).toBe(42)
    expect(parseSegParam(['7', '9'])).toBe(7)
    expect(parseSegParam('0')).toBeNull()
    expect(parseSegParam('-3')).toBeNull()
    expect(parseSegParam('abc')).toBeNull()
    expect(parseSegParam(undefined)).toBeNull()
  })

  it('encodeAdvancedFilter / decodeAdvancedFilter round-trip a definition', () => {
    const def = { entity: 'company' as const, include: [{ conditions: [{ kind: 'field' as const, field: 'company.state', op: 'is' as const, value: 'NY' }] }], exclude: [] }
    const encoded = encodeAdvancedFilter(def)
    expect(typeof encoded).toBe('string')
    expect(decodeAdvancedFilter(encoded)).toEqual(def)
  })

  it('decodeAdvancedFilter is honest about garbage: null, never a thrown error', () => {
    expect(decodeAdvancedFilter(undefined)).toBeNull()
    expect(decodeAdvancedFilter('')).toBeNull()
    expect(decodeAdvancedFilter('not json at all %%%')).toBeNull()
    expect(decodeAdvancedFilter(encodeURIComponent(JSON.stringify({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'nope.nope', op: 'is', value: 1 }] }] })))).toBeNull()
  })
})
