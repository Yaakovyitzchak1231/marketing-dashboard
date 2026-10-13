'use client'

import { INPUT, LABEL } from '@/components/campaigns/ui'
import type { Condition, FieldOp } from '@/lib/segments/definition'
import { OPS_BY_TYPE } from '@/lib/segments/definition'
import type { FieldDef } from '@/lib/segments/fields'

const OP_WORD: Record<string, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'does not contain',
  in: 'is any of', not_in: 'is none of', gt: '>', gte: '>=', lt: '<', lte: '<=', between: 'between',
  before: 'before', after: 'after', within_last_days: 'in the last N days', more_than_days_ago: 'more than N days ago',
  exists: 'is set', not_exists: 'is not set',
}

const NO_VALUE_OPS = new Set(['exists', 'not_exists'])
const LIST_VALUE_OPS = new Set(['in', 'not_in'])

function FieldRow({ cond, fields, onChange, onRemove }: {
  cond: Extract<Condition, { kind: 'field' }>
  fields: FieldDef[]
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  const def = fields.find((f) => f.key === cond.field)
  const ops = def ? (def.operators ?? OPS_BY_TYPE[def.type]) : OPS_BY_TYPE.text
  const needsValue = !NO_VALUE_OPS.has(cond.op)
  const isList = LIST_VALUE_OPS.has(cond.op)
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="condition-row-field">
      <label className={LABEL}>
        Field
        <select
          className={INPUT}
          value={cond.field}
          onChange={(e) => {
            const nd = fields.find((f) => f.key === e.target.value)
            const nextOps = nd ? (nd.operators ?? OPS_BY_TYPE[nd.type]) : OPS_BY_TYPE.text
            onChange({ kind: 'field', field: e.target.value, op: (nextOps[0] ?? 'is') as FieldOp })
          }}
        >
          {fields.map((f) => (
            <option key={f.key} value={f.key}>{f.label}</option>
          ))}
        </select>
      </label>
      <label className={LABEL}>
        Operator
        <select className={INPUT} value={cond.op} onChange={(e) => onChange({ ...cond, op: e.target.value as FieldOp, value: undefined, value2: undefined })}>
          {ops.map((op) => (
            <option key={op} value={op}>{OP_WORD[op] ?? op}</option>
          ))}
        </select>
      </label>
      {needsValue ? (
        <label className={LABEL}>
          {isList ? 'Value(s), comma-separated' : cond.op === 'between' ? 'From' : 'Value'}
          <input
            className={INPUT}
            value={isList ? (Array.isArray(cond.value) ? cond.value.join(', ') : '') : cond.value == null ? '' : String(cond.value)}
            onChange={(e) => onChange({ ...cond, value: isList ? e.target.value.split(',').map((s) => s.trim()).filter(Boolean) : e.target.value })}
          />
        </label>
      ) : null}
      {cond.op === 'between' ? (
        <label className={LABEL}>
          To
          <input className={INPUT} value={cond.value2 == null ? '' : String(cond.value2)} onChange={(e) => onChange({ ...cond, value2: e.target.value })} />
        </label>
      ) : null}
      <button type="button" onClick={onRemove} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-bad" aria-label="Remove condition">
        Remove
      </button>
    </div>
  )
}

function EventRow({ cond, onChange, onRemove }: {
  cond: Extract<Condition, { kind: 'event' }>
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="condition-row-event">
      <label className={LABEL}>
        Event
        <input className={INPUT} placeholder="e.g. email_opened" value={cond.event_type} onChange={(e) => onChange({ ...cond, event_type: e.target.value.trim() })} />
      </label>
      <label className={LABEL}>
        Count
        <select className={INPUT} value={cond.count_op} onChange={(e) => onChange({ ...cond, count_op: e.target.value as typeof cond.count_op })}>
          <option value="eq">exactly</option>
          <option value="gt">more than</option>
          <option value="gte">at least</option>
          <option value="lt">less than</option>
          <option value="lte">at most</option>
        </select>
      </label>
      <label className={LABEL}>
        Times
        <input className={INPUT} type="number" min={0} value={cond.count} onChange={(e) => { const parsed = Number(e.target.value); onChange({ ...cond, count: Number.isFinite(parsed) ? parsed : cond.count }) }} />
      </label>
      <label className={LABEL}>
        Within last days (optional)
        <input
          className={INPUT}
          type="number"
          min={1}
          value={cond.within_last_days ?? ''}
          onChange={(e) => onChange({ ...cond, within_last_days: e.target.value ? Number(e.target.value) : undefined })}
        />
      </label>
      <button type="button" onClick={onRemove} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-bad" aria-label="Remove condition">
        Remove
      </button>
    </div>
  )
}

function QualityRow({ cond, onChange, onRemove }: {
  cond: Extract<Condition, { kind: 'quality' }>
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="condition-row-quality">
      <label className={LABEL}>
        Quality
        <select className={INPUT} value={cond.op} onChange={(e) => onChange({ kind: 'quality', op: e.target.value as typeof cond.op })}>
          <option value="verified_sendable">Verified, sendable</option>
          <option value="not_verified_sendable">Not verified-sendable</option>
          <option value="suppressed">Suppressed</option>
          <option value="not_suppressed">Not suppressed</option>
        </select>
      </label>
      <button type="button" onClick={onRemove} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-bad" aria-label="Remove condition">
        Remove
      </button>
    </div>
  )
}

function CampaignRow({ cond, onChange, onRemove }: {
  cond: Extract<Condition, { kind: 'campaign_membership' }>
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="condition-row-campaign">
      <label className={LABEL}>
        Campaign status
        <select
          className={INPUT}
          value={cond.mode}
          onChange={(e) => onChange({ kind: 'campaign_membership', mode: e.target.value as typeof cond.mode, campaign_id: cond.campaign_id })}
        >
          <option value="any_active_campaign">In an active campaign</option>
          <option value="never_contacted">Never contacted in any campaign</option>
          <option value="in_campaign">In a specific campaign (id)</option>
        </select>
      </label>
      {cond.mode === 'in_campaign' ? (
        <label className={LABEL}>
          Campaign id
          <input className={INPUT} type="number" value={cond.campaign_id ?? ''} onChange={(e) => onChange({ ...cond, campaign_id: Number(e.target.value) || undefined })} />
        </label>
      ) : null}
      <button type="button" onClick={onRemove} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-bad" aria-label="Remove condition">
        Remove
      </button>
    </div>
  )
}

/** One editable condition row. The field registry drives the field/operator/value
 *  controls; other condition kinds (event, quality, campaign membership) get their
 *  own small set of controls. Unsupported-in-the-UI kinds (relative_date, segment
 *  refs) still render read-only via the plain-English phrase so nothing disappears
 *  if an AI-built or API-built definition is opened here. */
export function ConditionRow({ cond, fields, onChange, onRemove }: {
  cond: Condition
  fields: FieldDef[]
  onChange: (c: Condition) => void
  onRemove: () => void
}) {
  switch (cond.kind) {
    case 'field': return <FieldRow cond={cond} fields={fields} onChange={onChange} onRemove={onRemove} />
    case 'event': return <EventRow cond={cond} onChange={onChange} onRemove={onRemove} />
    case 'quality': return <QualityRow cond={cond} onChange={onChange} onRemove={onRemove} />
    case 'campaign_membership': return <CampaignRow cond={cond} onChange={onChange} onRemove={onRemove} />
    default:
      return (
        <div className="flex items-center gap-2 text-xs text-ink-muted" data-testid="condition-row-readonly">
          <span>{cond.kind} condition (edit via the API for now)</span>
          <button type="button" onClick={onRemove} className="text-xs text-ink-faint underline decoration-line underline-offset-2 hover:text-bad">
            Remove
          </button>
        </div>
      )
  }
}
