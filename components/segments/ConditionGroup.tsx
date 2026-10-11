'use client'

import { btnCls } from '@/components/ops/bits'
import { Card } from '@/components/dashboard/primitives'
import { ConditionRow } from './ConditionRow'
import type { Condition, ConditionGroup as ConditionGroupShape } from '@/lib/segments/definition'
import { defaultEventCondition, defaultFieldCondition, defaultQualityCondition } from '@/lib/segments/builder-state'
import type { FieldDef } from '@/lib/segments/fields'

/** One AND'd group of conditions, with an "add condition" picker and a remove-group
 *  button. Several of these, OR'd together, make up a definition's include or
 *  exclude list -- `joiner` ("and" between rows, "or" between groups) is just a
 *  label hint, not a control (the AND/OR structure is implied by nesting). */
export function ConditionGroupCard({
  group, fields, onChange, onRemoveGroup, label,
}: {
  group: ConditionGroupShape
  fields: FieldDef[]
  onChange: (next: ConditionGroupShape) => void
  onRemoveGroup: () => void
  label: string
}) {
  function updateCondition(i: number, next: Condition) {
    onChange({ conditions: group.conditions.map((c, j) => (j === i ? next : c)) })
  }
  function removeCondition(i: number) {
    onChange({ conditions: group.conditions.filter((_, j) => j !== i) })
  }
  function addCondition(kind: 'field' | 'event' | 'quality') {
    const c: Condition = kind === 'field' ? defaultFieldCondition(fields[0]?.key ?? '') : kind === 'event' ? defaultEventCondition() : defaultQualityCondition()
    onChange({ conditions: [...group.conditions, c] })
  }
  return (
    <Card className="space-y-2 p-3" data-testid="condition-group">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-ink-faint">{label} (all must match)</span>
        <button type="button" onClick={onRemoveGroup} className="text-[12px] text-ink-faint underline decoration-line underline-offset-2 hover:text-bad">
          Remove group
        </button>
      </div>
      <div className="space-y-2 divide-y divide-line">
        {group.conditions.map((c, i) => (
          <div key={i} className={i > 0 ? 'pt-2' : ''}>
            {i > 0 ? <p className="mb-1 text-[11px] font-semibold text-ink-faint">and</p> : null}
            <ConditionRow cond={c} fields={fields} onChange={(next) => updateCondition(i, next)} onRemove={() => removeCondition(i)} />
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5 pt-1">
        <button type="button" className={btnCls} onClick={() => addCondition('field')}>+ Field</button>
        <button type="button" className={btnCls} onClick={() => addCondition('event')}>+ Event</button>
        <button type="button" className={btnCls} onClick={() => addCondition('quality')}>+ Quality</button>
      </div>
    </Card>
  )
}
