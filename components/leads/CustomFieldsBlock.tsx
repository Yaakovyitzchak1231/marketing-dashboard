import { InlineEditCell } from '@/components/edit/InlineEditCell'
import type { FieldDefRow } from '@/lib/fields/registry'

/** Custom fields (plan 1.7) on a lead's company or contact, inline-editable the
 *  same way every other field on the lead page is. */
export function CustomFieldsBlock({
  entity,
  id,
  defs,
  values,
  label,
}: {
  entity: 'company' | 'contact'
  id: number
  defs: FieldDefRow[]
  values: Record<string, unknown>
  label: string
}) {
  if (!defs.length) return null
  return (
    <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 border-t border-line-soft pt-2 text-sm sm:grid-cols-2">
      <dt className="sm:col-span-2 text-2xs font-medium uppercase tracking-wide text-ink-faint">{label}</dt>
      {defs.map((def) => {
        const raw = values?.[def.key]
        const value = raw === null || raw === undefined ? null : Array.isArray(raw) ? raw.join(', ') : String(raw)
        const options =
          def.type === 'select' || def.type === 'multi_select'
            ? def.options.map((o) => ({ value: o, label: o }))
            : def.type === 'boolean'
              ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]
              : undefined
        return (
          <div key={def.id} className="flex items-baseline gap-2">
            <dt className="w-28 shrink-0 text-ink-faint">{def.label}</dt>
            <dd className="min-w-0 flex-1">
              <InlineEditCell type={entity} id={id} field={`custom.${def.key}`} value={value} label={def.label} options={options} />
            </dd>
          </div>
        )
      })}
    </dl>
  )
}
