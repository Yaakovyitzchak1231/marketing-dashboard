/**
 * Definition -> plain English, for the segment list, the builder's live
 * preview, and an agent that wants to describe a segment without reading JSON.
 * Pure function: no DB access, so it can run on a definition before it is saved.
 */
import { getField } from './fields.ts'
import type { Condition, ConditionGroup, SegmentDefinition } from './definition.ts'

function fieldLabel(key: string): string {
  return getField(key)?.label ?? key
}

function fmtValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => fmtValue(x)).join(' or ')
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v)) return v.slice(0, 10)
  return String(v)
}

function fieldPhrase(c: Extract<Condition, { kind: 'field' }>): string {
  const label = fieldLabel(c.field)
  switch (c.op) {
    case 'is': return `${label} is ${fmtValue(c.value)}`
    case 'is_not': return `${label} is not ${fmtValue(c.value)}`
    case 'contains': return `${label} contains "${fmtValue(c.value)}"`
    case 'not_contains': return `${label} does not contain "${fmtValue(c.value)}"`
    case 'in': return `${label} is ${fmtValue(c.value)}`
    case 'not_in': return `${label} is not ${fmtValue(c.value)}`
    case 'gt': return `${label} is more than ${fmtValue(c.value)}`
    case 'gte': return `${label} is at least ${fmtValue(c.value)}`
    case 'lt': return `${label} is less than ${fmtValue(c.value)}`
    case 'lte': return `${label} is at most ${fmtValue(c.value)}`
    case 'between': return `${label} is between ${fmtValue(c.value)} and ${fmtValue(c.value2)}`
    case 'before': return `${label} is before ${fmtValue(c.value)}`
    case 'after': return `${label} is after ${fmtValue(c.value)}`
    case 'within_last_days': return `${label} was in the last ${fmtValue(c.value)} days`
    case 'more_than_days_ago': return `${label} was more than ${fmtValue(c.value)} days ago`
    case 'exists': return `${label} is set`
    case 'not_exists': return `${label} is not set`
    default: return `${label} ${c.op} ${fmtValue((c as { value?: unknown }).value)}`
  }
}

function eventPhrase(c: Extract<Condition, { kind: 'event' }>): string {
  const opWord = { eq: 'exactly', gt: 'more than', gte: 'at least', lt: 'less than', lte: 'at most' }[c.count_op]
  const window = c.within_last_days ? ` in the last ${c.within_last_days} days` : ''
  const prop = c.prop ? ` where ${c.prop.path.slice('props.'.length)} ${c.prop.op === 'is' ? 'is' : 'contains'} "${c.prop.value}"` : ''
  return `"${c.event_type}" ${opWord} ${c.count} time${c.count === 1 ? '' : 's'}${window}${prop}`
}

function relativeDatePhrase(c: Extract<Condition, { kind: 'relative_date' }>): string {
  const label = fieldLabel(c.field)
  const anchor = c.compare_to ? fieldLabel(c.compare_to) : 'now'
  return `${label} is more than ${c.days} days ${c.op} ${anchor}`
}

function campaignPhrase(c: Extract<Condition, { kind: 'campaign_membership' }>): string {
  if (c.mode === 'in_campaign') return `in campaign #${c.campaign_id}`
  if (c.mode === 'any_active_campaign') return 'in an active campaign'
  return 'never contacted in any campaign'
}

function qualityPhrase(c: Extract<Condition, { kind: 'quality' }>): string {
  switch (c.op) {
    case 'suppressed': return 'suppressed'
    case 'not_suppressed': return 'not suppressed'
    case 'verified_sendable': return 'verified email, sendable'
    case 'not_verified_sendable': return 'not verified-sendable'
  }
}

function conditionPhrase(c: Condition): string {
  switch (c.kind) {
    case 'field': return fieldPhrase(c)
    case 'event': return eventPhrase(c)
    case 'relative_date': return relativeDatePhrase(c)
    case 'campaign_membership': return campaignPhrase(c)
    case 'quality': return qualityPhrase(c)
    case 'in_segment': return `in segment #${c.segment_id}`
    case 'not_in_segment': return `not in segment #${c.segment_id}`
  }
}

function groupPhrase(g: ConditionGroup): string {
  const parts = g.conditions.map(conditionPhrase)
  if (parts.length === 1) return parts[0]
  return `(${parts.join(' and ')})`
}

function groupsPhrase(groups: ConditionGroup[]): string {
  return groups.map(groupPhrase).join(' or ')
}

/** "Leads where state is NY or NJ, verified email, no reply in the last 30 days,
 *  and not in any active campaign." Entity-aware noun ("Leads" / "Contacts"). */
export function readback(def: SegmentDefinition): string {
  const noun = def.entity === 'company' ? 'Leads' : 'Contacts'
  const includeText = def.include.length ? groupsPhrase(def.include) : 'all'
  const excludeText = def.exclude.length ? groupsPhrase(def.exclude) : null
  let out = `${noun} where ${includeText}`
  if (excludeText) out += `, excluding ${excludeText}`
  return out + '.'
}
