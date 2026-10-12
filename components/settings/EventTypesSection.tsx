import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { TD, TDN, TH } from '@/components/reports/bits'
import { EVENT_TYPE_CATEGORIES, isBuiltInEventType, type EventTypeListRow } from '@/lib/events/types-store'

type FormAction = (f: FormData) => void | Promise<void>

function fmtDate(v: string | Date): string {
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

function CategorySelect({ value, label }: { value?: string; label: string }) {
  return (
    <select name="category" aria-label={label} defaultValue={value ?? 'custom'} className={inputCls}>
      {EVENT_TYPE_CATEGORIES.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </select>
  )
}

/**
 * The event type registry as a table. `canEdit` (Editor/Owner) adds the forms;
 * a Viewer gets the same table with no controls. Built-in types (source
 * instantly/system) are never editable: the webhook and history trigger write them.
 */
export function EventTypesSection({
  types,
  canEdit,
  registerAction,
  updateAction,
  setActiveAction,
}: {
  types: EventTypeListRow[]
  canEdit: boolean
  registerAction: FormAction
  updateAction: FormAction
  setActiveAction: FormAction
}) {
  return (
    <>
      {canEdit ? (
        <section className="mb-6" data-testid="event-type-register">
          <SectionHeader title="Register a type" />
          <Card className="p-4">
            <form action={registerAction} className="flex flex-wrap items-center gap-2">
              <input name="key" aria-label="Key" placeholder="review_posted" required className={`${inputCls} w-44`} />
              <input name="label" aria-label="Label" placeholder="Review posted" required maxLength={80} className={`${inputCls} w-48`} />
              <CategorySelect label="Category" />
              <button type="submit" className={primaryBtnCls}>
                Register
              </button>
            </form>
            <p className="mt-2 text-[12px] text-ink-faint">Key: lowercase letters, digits, &apos;_&apos; or &apos;.&apos;, starting with a letter. The key can&apos;t be changed later.</p>
          </Card>
        </section>
      ) : null}

      <section className="mb-6">
        <SectionHeader title="Event types" meta={`${types.length} registered`} />
        <p className="mb-2 text-[12.5px] text-ink-muted">
          An inactive type is refused by track_event and track_events until it is activated again. Built-in types come from Instantly and the
          status history, so they can&apos;t be relabelled or deactivated. Stored events counts the rows in lp.lead_events.
        </p>
        {!types.length ? (
          <EmptyNote>No event types registered.</EmptyNote>
        ) : (
          <Card className="overflow-x-auto p-0">
            <table className="w-full border-collapse text-[13px]" data-testid="event-types-table">
              <thead>
                <tr className="border-b border-line">
                  <th className={TH}>Key</th>
                  <th className={TH}>Label</th>
                  <th className={TH}>Category</th>
                  <th className={TH}>Source</th>
                  <th className={TH}>Status</th>
                  <th className={`${TH} text-right`}>Stored events</th>
                  <th className={TH}>Created</th>
                  {canEdit ? <th className={TH}>Change</th> : null}
                </tr>
              </thead>
              <tbody>
                {types.map((t) => {
                  const builtIn = isBuiltInEventType(t)
                  return (
                    <tr key={t.key} className="border-b border-line/60" data-testid={`event-type-${t.key}`}>
                      <td className={`${TD} font-mono text-[12px]`}>{t.key}</td>
                      <td className={TD}>{t.label}</td>
                      <td className={TD}>{t.category}</td>
                      <td className={TD}>
                        {t.source}
                        {builtIn ? <span className="ml-1.5 text-[11px] text-ink-faint">built-in</span> : null}
                      </td>
                      <td className={TD}>{t.active ? <Pill tone="good">Active</Pill> : <Pill tone="neutral">Inactive</Pill>}</td>
                      <td className={TDN}>{t.stored_count}</td>
                      <td className={`${TD} tabular-nums text-ink-muted`}>
                        {fmtDate(t.created_at)}
                        {t.created_by ? <span className="block text-[11.5px]">{t.created_by_name ?? t.created_by}</span> : null}
                      </td>
                      {canEdit ? (
                        <td className={TD}>
                          {builtIn ? (
                            <span className="text-[12px] text-ink-faint">Fixed</span>
                          ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                              <form action={updateAction} className="flex flex-wrap items-center gap-1.5">
                                <input type="hidden" name="key" value={t.key} />
                                <input name="label" aria-label={`Label for ${t.key}`} defaultValue={t.label} required maxLength={80} className={`${inputCls} w-40`} />
                                <CategorySelect value={t.category} label={`Category for ${t.key}`} />
                                <button type="submit" className={btnCls}>
                                  Save
                                </button>
                              </form>
                              <form action={setActiveAction}>
                                <input type="hidden" name="key" value={t.key} />
                                <input type="hidden" name="active" value={t.active ? 'false' : 'true'} />
                                <button type="submit" className={btnCls}>
                                  {t.active ? 'Deactivate' : 'Activate'}
                                </button>
                              </form>
                            </div>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </Card>
        )}
      </section>
    </>
  )
}
