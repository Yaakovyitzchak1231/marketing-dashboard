import { describe, it, expect } from 'vitest'
import { validateDefinition, DefinitionError } from '@/lib/segments/definition'
import { readback } from '@/lib/segments/readback'

describe('segment definition validator', () => {
  it('accepts a minimal valid definition', () => {
    const def = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'is', value: 'NY' }] }],
    })
    expect(def.entity).toBe('company')
    expect(def.include).toHaveLength(1)
    expect(def.exclude).toEqual([])
  })

  it('rejects an unknown field', () => {
    expect(() =>
      validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.nope', op: 'is', value: 'x' }] }] }),
    ).toThrow(DefinitionError)
  })

  it('rejects an operator not valid for the field type', () => {
    // company.stage is text; "gt" is a number-only operator
    expect(() =>
      validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.stage', op: 'gt', value: 'x' }] }] }),
    ).toThrow(/operator/)
  })

  it('rejects an unknown top-level key (unknown fields rejected, not ignored)', () => {
    expect(() => validateDefinition({ entity: 'company', include: [], exclude: [], bogus: true })).toThrow(/unknown field/)
  })

  it('rejects an unknown condition kind', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'wat' }] }] })).toThrow(/unknown condition kind/)
  })

  it('requires entity to be company or contact', () => {
    expect(() => validateDefinition({ entity: 'nope', include: [] })).toThrow(/entity/)
  })

  it('rejects an empty group (vacuous AND of nothing)', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [] }] })).toThrow(/non-empty/)
  })

  it('"in" / "not_in" require a non-empty array', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: 'NY' }] }] })).toThrow()
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: [] }] }] })).toThrow()
    const ok = validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }] }] })
    expect((ok.include[0].conditions[0] as { value: unknown }).value).toEqual(['NY', 'NJ'])
  })

  it('"between" requires value and value2', () => {
    expect(() =>
      validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.created_at', op: 'between', value: '2026-01-01' }] }] }),
    ).toThrow(/between/)
    const ok = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.created_at', op: 'between', value: '2026-01-01', value2: '2026-02-01' }] }],
    })
    expect(ok.include[0].conditions[0].kind).toBe('field')
  })

  it('"exists" / "not_exists" need no value', () => {
    const ok = validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'field', field: 'company.website_domain', op: 'exists' }] }] })
    expect((ok.include[0].conditions[0] as { value?: unknown }).value).toBeUndefined()
  })

  it('an injection-looking value is stored as a plain string value, not rejected or specially handled', () => {
    const def = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.name', op: 'is', value: "Robert'); DROP TABLE lp.companies;--" }] }],
    })
    expect((def.include[0].conditions[0] as { value: unknown }).value).toBe("Robert'); DROP TABLE lp.companies;--")
  })

  it('validates event conditions: unknown count_op rejected, prop.path must look like "props.<key>"', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'event', event_type: 'email_opened', count_op: 'wat', count: 1 }] }] })).toThrow()
    expect(() =>
      validateDefinition({
        entity: 'company',
        include: [{ conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1, prop: { path: 'url', op: 'contains', value: '/pricing' } }] }],
      }),
    ).toThrow(/prop\.path/)
    const ok = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'event', event_type: 'email_link_clicked', count_op: 'gte', count: 1, prop: { path: 'props.url', op: 'contains', value: '/pricing' } }] }],
    })
    expect(ok.include[0].conditions[0].kind).toBe('event')
  })

  it('validates relative_date: field and compare_to must be date fields', () => {
    expect(() =>
      validateDefinition({ entity: 'contact', include: [{ conditions: [{ kind: 'relative_date', field: 'contact.email', op: 'after', days: 3 }] }] }),
    ).toThrow(/date field/)
    const ok = validateDefinition({
      entity: 'contact',
      include: [{ conditions: [{ kind: 'relative_date', field: 'contact.verified_at', op: 'after', days: 3, compare_to: 'contact.created_at' }] }],
    })
    expect(ok.include[0].conditions[0].kind).toBe('relative_date')
  })

  it('validates campaign_membership: in_campaign requires campaign_id', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'in_campaign' }] }] })).toThrow(/campaign_id/)
    const ok = validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'campaign_membership', mode: 'never_contacted' }] }] })
    expect(ok.include[0].conditions[0].kind).toBe('campaign_membership')
  })

  it('validates quality op', () => {
    expect(() => validateDefinition({ entity: 'contact', include: [{ conditions: [{ kind: 'quality', op: 'nope' }] }] })).toThrow()
  })

  it('validates in_segment segment_id is a positive integer', () => {
    expect(() => validateDefinition({ entity: 'company', include: [{ conditions: [{ kind: 'in_segment', segment_id: -1 }] }] })).toThrow()
  })
})

describe('readback', () => {
  it('reads an include-only definition in plain English', () => {
    const def = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'field', field: 'company.state', op: 'in', value: ['NY', 'NJ'] }, { kind: 'quality', op: 'verified_sendable' }] }],
    })
    const text = readback(def)
    expect(text).toContain('State is NY or NJ')
    expect(text).toContain('verified email, sendable')
    expect(text.startsWith('Leads where')).toBe(true)
  })

  it('reads an include + exclude definition', () => {
    const def = validateDefinition({
      entity: 'company',
      include: [{ conditions: [{ kind: 'event', event_type: 'reply_received', count_op: 'eq', count: 0, within_last_days: 30 }] }],
      exclude: [{ conditions: [{ kind: 'campaign_membership', mode: 'any_active_campaign' }] }],
    })
    const text = readback(def)
    expect(text).toContain('"reply_received" exactly 0 times in the last 30 days')
    expect(text).toContain('excluding in an active campaign')
  })

  it('reads a contact-entity definition with "Contacts"', () => {
    const def = validateDefinition({ entity: 'contact', include: [{ conditions: [{ kind: 'field', field: 'contact.verification_status', op: 'is', value: 'valid' }] }] })
    expect(readback(def).startsWith('Contacts where')).toBe(true)
  })
})
