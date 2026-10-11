/**
 * Pure helpers the segment builder UI (components/segments/*) uses to edit a
 * SegmentDefinition's include/exclude groups immutably -- no DB, no React,
 * so they round-trip test on their own. The builder's React state IS a
 * SegmentDefinition (plus name/description/campaign_id); these functions are
 * the only way it is ever mutated, so every edit stays something
 * validateDefinition() accepts.
 */
import { getField } from './fields.ts'
import type { Condition, ConditionGroup, FieldOp, SegmentDefinition, SegmentEntity } from './definition.ts'

export function emptyDefinition(entity: SegmentEntity): SegmentDefinition {
  return { entity, include: [], exclude: [] }
}

/** A sensible default condition when a person picks a field from the registry:
 *  the field's first allowed operator, no value yet (the row then asks for one). */
export function defaultFieldCondition(fieldKey: string): Condition {
  const f = getField(fieldKey)
  const op = (f?.operators?.[0] ?? 'is') as FieldOp
  return { kind: 'field', field: fieldKey, op }
}

export function defaultEventCondition(): Condition {
  return { kind: 'event', event_type: '', count_op: 'gte', count: 1 }
}

export function defaultQualityCondition(): Condition {
  return { kind: 'quality', op: 'verified_sendable' }
}

export function defaultCampaignMembershipCondition(): Condition {
  return { kind: 'campaign_membership', mode: 'any_active_campaign' }
}

export function addGroup(groups: ConditionGroup[], firstCondition: Condition): ConditionGroup[] {
  return [...groups, { conditions: [firstCondition] }]
}

export function removeGroup(groups: ConditionGroup[], groupIndex: number): ConditionGroup[] {
  return groups.filter((_, i) => i !== groupIndex)
}

export function addConditionToGroup(groups: ConditionGroup[], groupIndex: number, condition: Condition): ConditionGroup[] {
  return groups.map((g, i) => (i === groupIndex ? { conditions: [...g.conditions, condition] } : g))
}

/** Removes one condition; a group left with zero conditions is dropped entirely
 *  (an empty group is not a valid group -- validateDefinition requires >=1). */
export function removeConditionFromGroup(groups: ConditionGroup[], groupIndex: number, condIndex: number): ConditionGroup[] {
  return groups
    .map((g, i) => (i === groupIndex ? { conditions: g.conditions.filter((_, j) => j !== condIndex) } : g))
    .filter((g) => g.conditions.length > 0)
}

export function updateConditionInGroup(groups: ConditionGroup[], groupIndex: number, condIndex: number, next: Condition): ConditionGroup[] {
  return groups.map((g, i) => (i === groupIndex ? { conditions: g.conditions.map((c, j) => (j === condIndex ? next : c)) } : g))
}

export function withGroups(def: SegmentDefinition, which: 'include' | 'exclude', groups: ConditionGroup[]): SegmentDefinition {
  return { ...def, [which]: groups }
}

export function withEntity(def: SegmentDefinition, entity: SegmentEntity): SegmentDefinition {
  // Changing entity invalidates every existing field/event condition's meaning, so a
  // builder switching entity starts the groups over -- never silently keeps stale conditions.
  return { entity, include: [], exclude: [] }
}
