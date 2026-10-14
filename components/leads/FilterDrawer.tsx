'use client'

import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { FilterBadge } from './FilterBadge'
import { fetchRole } from '@/components/auth/useRole'
import { failedWriteText, thrownWriteText } from '@/components/auth/viewOnly'

type FieldType = 'text' | 'number' | 'boolean' | 'date' | 'array'
interface FieldDef { key: string; label: string; table: 'company' | 'contact'; type: FieldType; operators?: readonly string[] }
const OPS_BY_TYPE: Record<FieldType, readonly string[]> = {
  text: ['is', 'is_not', 'contains', 'not_contains', 'in', 'not_in', 'exists', 'not_exists'],
  number: ['is', 'is_not', 'gt', 'gte', 'lt', 'lte', 'between', 'in', 'not_in', 'exists', 'not_exists'],
  date: ['is', 'is_not', 'before', 'after', 'within_last_days', 'more_than_days_ago', 'between', 'exists', 'not_exists'],
  boolean: ['is', 'is_not', 'exists', 'not_exists'],
  array: ['contains', 'not_contains', 'in', 'not_in', 'exists', 'not_exists'],
}
const OP_LABEL: Record<string, string> = {
  is: 'is', is_not: 'is not', contains: 'contains', not_contains: 'doesn’t contain', in: 'is one of', not_in: 'is not one of',
  gt: '>', gte: '>=', lt: '<', lte: '<=', between: 'between', before: 'before', after: 'after',
  within_last_days: 'within the last (days)', more_than_days_ago: 'more than (days) ago', exists: 'is set', not_exists: 'is not set',
}
const NO_VALUE_OPS = new Set(['exists', 'not_exists'])
const TWO_VALUE_OPS = new Set(['between'])

type FieldRow = { id: number; type: 'field'; field: string; op: string; value: string; value2: string }
type EventRow = { id: number; type: 'event'; event_type: string; count_op: 'eq' | 'gt' | 'gte' | 'lt' | 'lte'; count: string; within_last_days: string }
type Row = FieldRow | EventRow
let nextRowId = 1

function rawValue(type: FieldType, raw: string): unknown {
  if (type === 'number') return Number(raw)
  if (type === 'boolean') return raw === 'true'
  return raw
}

function rowToCondition(r: Row, fieldsByKey: Map<string, FieldDef>): Record<string, unknown> | null {
  if (r.type === 'event') {
    if (!r.event_type || !r.count.trim()) return null
    const out: Record<string, unknown> = { kind: 'event', event_type: r.event_type, count_op: r.count_op, count: Number(r.count) }
    if (r.within_last_days.trim()) out.within_last_days = Number(r.within_last_days)
    return out
  }
  const f = fieldsByKey.get(r.field)
  if (!f || !r.op) return null
  const out: Record<string, unknown> = { kind: 'field', field: r.field, op: r.op }
  if (NO_VALUE_OPS.has(r.op)) return out
  if (r.op === 'in' || r.op === 'not_in') {
    if (!r.value.trim()) return null
    out.value = r.value.split(',').map((s) => s.trim()).filter(Boolean)
    return out
  }
  if (!r.value.trim()) return null
  out.value = rawValue(f.type, r.value)
  if (TWO_VALUE_OPS.has(r.op)) {
    if (!r.value2.trim()) return null
    out.value2 = rawValue(f.type, r.value2)
  }
  return out
}

/**
 * "Advanced filters" (plan 2.5): a drawer with three tabs over /leads --
 * Standard (company field conditions), Saved segments (apply one by id), and
 * Behaviour (event conditions, e.g. "opened 3+ times in 14 days"). Standard +
 * Behaviour rows combine into one ad-hoc segment definition (?f=, one AND
 * group); Saved segments applies ?seg=<id> instead. Both write through
 * lib/leads/filters.ts's encode/decode so the URL round-trips. Self-contained:
 * fetches its own field registry / segment list / event types; nothing else
 * on the Leads screen reads or writes through this file.
 */
export function FilterDrawer({
  activeSegId,
  activeHasAdHoc,
  activeRowCount,
  matching,
}: {
  activeSegId: number | null
  activeHasAdHoc: boolean
  activeRowCount: number
  matching: number | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'standard' | 'saved' | 'behaviour'>(activeSegId ? 'saved' : 'standard')
  const [fields, setFields] = useState<FieldDef[]>([])
  const [eventTypes, setEventTypes] = useState<{ key: string; label: string }[]>([])
  const [segments, setSegments] = useState<{ id: number; name: string }[]>([])
  const [rows, setRows] = useState<Row[]>([])
  const [segChoice, setSegChoice] = useState<number | null>(activeSegId)
  const [preview, setPreview] = useState<{ companies: number } | null>(null)
  const [saveName, setSaveName] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    fetch('/api/leads/fields').then((r) => r.json()).then((b: { fields?: FieldDef[] }) => setFields(b.fields ?? [])).catch(() => {})
    fetch('/api/leads/event-types').then((r) => r.json()).then((b: { event_types?: { key: string; label: string }[] }) => setEventTypes(b.event_types ?? [])).catch(() => {})
    fetch('/api/leads/segments').then((r) => r.json()).then((b: { segments?: { id: number; name: string; kind: string }[] }) => setSegments((b.segments ?? []).filter((s) => s.kind !== 'static'))).catch(() => {})
  }, [open])

  const fieldsByKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields])
  const companyFields = useMemo(() => fields.filter((f) => f.table === 'company'), [fields])

  const definition = useMemo(() => {
    const conditions = rows.map((r) => rowToCondition(r, fieldsByKey)).filter((c): c is Record<string, unknown> => c != null)
    if (!conditions.length) return null
    return { entity: 'company', include: [{ conditions }], exclude: [] }
  }, [rows, fieldsByKey])

  // Live match count (segment_preview), debounced -- the badge's "N matching".
  useEffect(() => {
    if (tab === 'saved' || !definition) {
      setPreview(null)
      return
    }
    const t = setTimeout(() => {
      fetch('/api/leads/segments/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ definition }) })
        .then((r) => r.json())
        .then((b: { counts?: { companies: number } }) => setPreview(b.counts ? { companies: b.counts.companies } : null))
        .catch(() => setPreview(null))
    }, 400)
    return () => clearTimeout(t)
  }, [definition, tab])

  function addFieldRow() {
    const first = companyFields[0]
    setRows((r) => [...r, { id: nextRowId++, type: 'field', field: first?.key ?? '', op: first ? (first.operators ?? OPS_BY_TYPE[first.type])[0] : 'is', value: '', value2: '' }])
  }
  function addEventRow() {
    setRows((r) => [...r, { id: nextRowId++, type: 'event', event_type: eventTypes[0]?.key ?? '', count_op: 'gte', count: '1', within_last_days: '' }])
  }
  function removeRow(id: number) {
    setRows((r) => r.filter((x) => x.id !== id))
  }
  function patchRow(id: number, patch: Partial<Row>) {
    setRows((r) => r.map((x) => (x.id === id ? ({ ...x, ...patch } as Row) : x)))
  }

  function navigate(params: { seg?: number | null; f?: string | null }) {
    const u = new URLSearchParams(window.location.search)
    u.delete('seg')
    u.delete('f')
    u.delete('page')
    if (params.seg) u.set('seg', String(params.seg))
    if (params.f) u.set('f', params.f)
    router.push(`/leads${u.size ? `?${u}` : ''}`)
    setOpen(false)
  }

  function applySaved() {
    if (!segChoice) return
    navigate({ seg: segChoice })
  }
  function applyBuilt() {
    if (!definition) return
    navigate({ f: encodeURIComponent(JSON.stringify(definition)) })
  }
  function clearAdvanced() {
    navigate({})
  }

  async function saveAsSegment() {
    if (!definition || !saveName.trim()) return
    setBusy(true)
    setNote(null)
    try {
      const res = await fetch('/api/leads/segments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: saveName.trim(), definition }) })
      const body = (await res.json().catch(() => null)) as { id?: number; error?: string } | null
      if (!res.ok || !body?.id) setNote(res.ok ? (body?.error ?? `Couldn\u2019t save the segment (${res.status}).`) : failedWriteText(res.status, body?.error, `Couldn\u2019t save the segment (${res.status}).`, await fetchRole()))
      else navigate({ seg: body.id })
    } catch (err) {
      setNote(thrownWriteText(err, await fetchRole()))
    } finally {
      setBusy(false)
    }
  }

  const activeCount = activeSegId ? 1 : activeRowCount
  return (
    <div className="relative">
      <button type="button" onClick={() => setOpen((v) => !v)} className="rounded-control border border-line bg-surface px-2 py-1">
        <FilterBadge activeCount={activeCount} matching={activeSegId || activeHasAdHoc ? matching : null} />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 w-[420px] max-w-[90vw] rounded-card border border-line bg-surface p-3 text-sm shadow-card">
          <div className="mb-2 flex gap-1 border-b border-line-soft pb-2">
            {(['standard', 'saved', 'behaviour'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded-card px-2 py-1 text-xs ${tab === t ? 'bg-accent-soft text-ink' : 'text-ink-faint hover:text-ink'}`}
              >
                {t === 'standard' ? 'Standard' : t === 'saved' ? 'Saved segments' : 'Behaviour'}
              </button>
            ))}
            <button type="button" className="ml-auto text-xs text-ink-faint hover:text-ink" onClick={() => setOpen(false)}>
              Close
            </button>
          </div>

          {tab === 'saved' ? (
            <div className="space-y-2">
              {segments.length ? (
                <ul className="max-h-60 space-y-1 overflow-auto">
                  {segments.map((s) => (
                    <li key={s.id}>
                      <label className="flex items-center gap-2">
                        <input type="radio" name="seg" checked={segChoice === s.id} onChange={() => setSegChoice(s.id)} />
                        {s.name}
                      </label>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-xs text-ink-faint">No saved segments yet -- build one in the Standard or Behaviour tab and “Save as segment”.</p>
              )}
              <div className="flex gap-2 border-t border-line-soft pt-2">
                <button type="button" className={BUTTON_PRIMARY} disabled={!segChoice} onClick={applySaved}>
                  Apply
                </button>
                {activeSegId || activeHasAdHoc ? (
                  <button type="button" className={BUTTON} onClick={clearAdvanced}>
                    Clear
                  </button>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <ul className="max-h-60 space-y-2 overflow-auto">
                {rows
                  .filter((r) => (tab === 'standard' ? r.type === 'field' : r.type === 'event'))
                  .map((r) =>
                    r.type === 'field' ? (
                      <li key={r.id} className="flex flex-wrap items-center gap-1">
                        <select value={r.field} onChange={(e) => {
                          const f = fieldsByKey.get(e.target.value)
                          patchRow(r.id, { field: e.target.value, op: f ? (f.operators ?? OPS_BY_TYPE[f.type])[0] : r.op, value: '', value2: '' })
                        }} className="rounded-control border border-line bg-surface px-1.5 py-1 text-xs">
                          {companyFields.map((f) => (
                            <option key={f.key} value={f.key}>{f.label}</option>
                          ))}
                        </select>
                        <select value={r.op} onChange={(e) => patchRow(r.id, { op: e.target.value })} className="rounded-control border border-line bg-surface px-1.5 py-1 text-xs">
                          {(fieldsByKey.get(r.field)?.operators ?? OPS_BY_TYPE[fieldsByKey.get(r.field)?.type ?? 'text']).map((op) => (
                            <option key={op} value={op}>{OP_LABEL[op] ?? op}</option>
                          ))}
                        </select>
                        {!NO_VALUE_OPS.has(r.op) ? (
                          <input value={r.value} onChange={(e) => patchRow(r.id, { value: e.target.value })} placeholder={r.op === 'in' || r.op === 'not_in' ? 'a, b, c' : 'value'} className="w-24 rounded-control border border-line bg-surface px-1.5 py-1 text-xs" />
                        ) : null}
                        {TWO_VALUE_OPS.has(r.op) ? (
                          <input value={r.value2} onChange={(e) => patchRow(r.id, { value2: e.target.value })} placeholder="and" className="w-20 rounded-control border border-line bg-surface px-1.5 py-1 text-xs" />
                        ) : null}
                        <button type="button" onClick={() => removeRow(r.id)} className="ml-auto text-ink-faint hover:text-bad" aria-label="Remove filter">×</button>
                      </li>
                    ) : (
                      <li key={r.id} className="flex flex-wrap items-center gap-1">
                        <select value={r.event_type} onChange={(e) => patchRow(r.id, { event_type: e.target.value })} className="rounded-control border border-line bg-surface px-1.5 py-1 text-xs">
                          {eventTypes.map((e) => (
                            <option key={e.key} value={e.key}>{e.label}</option>
                          ))}
                        </select>
                        <select value={r.count_op} onChange={(e) => patchRow(r.id, { count_op: e.target.value as EventRow['count_op'] })} className="rounded-control border border-line bg-surface px-1.5 py-1 text-xs">
                          <option value="gte">at least</option>
                          <option value="gt">more than</option>
                          <option value="eq">exactly</option>
                          <option value="lt">fewer than</option>
                          <option value="lte">at most</option>
                        </select>
                        <input value={r.count} onChange={(e) => patchRow(r.id, { count: e.target.value })} className="w-12 rounded-control border border-line bg-surface px-1.5 py-1 text-xs" />
                        <span className="text-2xs text-ink-faint">times, within</span>
                        <input value={r.within_last_days} onChange={(e) => patchRow(r.id, { within_last_days: e.target.value })} placeholder="days" className="w-14 rounded-control border border-line bg-surface px-1.5 py-1 text-xs" />
                        <button type="button" onClick={() => removeRow(r.id)} className="ml-auto text-ink-faint hover:text-bad" aria-label="Remove behaviour">×</button>
                      </li>
                    ),
                  )}
              </ul>
              <button type="button" className={BUTTON} onClick={tab === 'standard' ? addFieldRow : addEventRow}>
                + {tab === 'standard' ? 'Add a filter' : 'Add a behaviour'}
              </button>
              {preview ? <p className="text-xs text-ink">{preview.companies.toLocaleString('en-US')} matching right now.</p> : null}
              <div className="flex flex-wrap items-center gap-2 border-t border-line-soft pt-2">
                <button type="button" className={BUTTON_PRIMARY} disabled={!definition} onClick={applyBuilt}>
                  Apply
                </button>
                {activeSegId || activeHasAdHoc ? (
                  <button type="button" className={BUTTON} onClick={clearAdvanced}>
                    Clear
                  </button>
                ) : null}
                <input value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="Save as segment…" className="min-w-0 flex-1 rounded-control border border-line bg-surface px-1.5 py-1 text-xs" />
                <button type="button" className={BUTTON} disabled={busy || !definition || !saveName.trim()} onClick={saveAsSegment}>
                  Save
                </button>
              </div>
              {note ? <p className="text-xs text-bad">{note}</p> : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}
