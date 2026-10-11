import { describe, it, expect } from 'vitest'
import {
  addConditionToGroup, addGroup, defaultEventCondition, defaultFieldCondition, defaultQualityCondition,
  emptyDefinition, removeConditionFromGroup, removeGroup, updateConditionInGroup, withEntity, withGroups,
} from '@/lib/segments/builder-state'
import { validateDefinition } from '@/lib/segments/definition'

describe('segment builder state (pure functions, plan 2.2)', () => {
  it('builds a definition up from empty through add/update/remove and it stays valid at every step', () => {
    let def = emptyDefinition('contact')
    expect(validateDefinition(def)).toEqual({ entity: 'contact', include: [], exclude: [] })

    // add an include group with one field condition
    def = withGroups(def, 'include', addGroup(def.include, defaultFieldCondition('contact.status')))
    expect(def.include).toHaveLength(1)
    expect(def.include[0].conditions).toEqual([{ kind: 'field', field: 'contact.status', op: 'is' }])
    expect(() => validateDefinition(def)).toThrow() // "is" needs a value -- not valid yet

    // give it a value
    def = withGroups(def, 'include', updateConditionInGroup(def.include, 0, 0, { kind: 'field', field: 'contact.status', op: 'is', value: 'new' }))
    expect(validateDefinition(def).include[0].conditions[0]).toMatchObject({ field: 'contact.status', op: 'is', value: 'new' })

    // add a second condition to the same group (AND)
    def = withGroups(def, 'include', addConditionToGroup(def.include, 0, defaultQualityCondition()))
    expect(def.include[0].conditions).toHaveLength(2)
    expect(validateDefinition(def).include[0].conditions).toHaveLength(2)

    // add a second group (OR)
    def = withGroups(def, 'include', addGroup(def.include, defaultEventCondition()))
    expect(def.include).toHaveLength(2)

    // removing the only condition in a group removes the whole group
    def = withGroups(def, 'include', removeConditionFromGroup(def.include, 1, 0))
    expect(def.include).toHaveLength(1)

    // removing a condition from a multi-condition group keeps the group
    def = withGroups(def, 'include', removeConditionFromGroup(def.include, 0, 1))
    expect(def.include).toHaveLength(1)
    expect(def.include[0].conditions).toHaveLength(1)

    // removeGroup drops a whole group outright
    const withExtra = withGroups(def, 'include', addGroup(def.include, defaultQualityCondition()))
    expect(withExtra.include).toHaveLength(2)
    const back = withGroups(withExtra, 'include', removeGroup(withExtra.include, 1))
    expect(back).toEqual(def)

    expect(validateDefinition(def)).toEqual(def)
  })

  it('withEntity resets include/exclude (a stale condition from the other entity can never survive)', () => {
    const def = withGroups(emptyDefinition('company'), 'include', addGroup([], defaultFieldCondition('company.state')))
    const switched = withEntity(def, 'contact')
    expect(switched).toEqual({ entity: 'contact', include: [], exclude: [] })
  })

  it('round-trips a hand-built definition exactly through the same helpers used to build it', () => {
    const expected = {
      entity: 'company' as const,
      include: [{ conditions: [{ kind: 'field' as const, field: 'company.state', op: 'is' as const, value: 'NY' }] }],
      exclude: [{ conditions: [{ kind: 'quality' as const, op: 'suppressed' as const }] }],
    }
    let def = emptyDefinition('company')
    def = withGroups(def, 'include', addGroup(def.include, { kind: 'field', field: 'company.state', op: 'is', value: 'NY' }))
    def = withGroups(def, 'exclude', addGroup(def.exclude, { kind: 'quality', op: 'suppressed' }))
    expect(def).toEqual(expected)
    expect(validateDefinition(def)).toEqual(expected)
  })
})
