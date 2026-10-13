import { getDb } from '@/lib/db'
import { listTraits } from '@/lib/traits/store'
import { ensureTraitFieldsRegistered } from '@/lib/traits/register'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { defineTraitAction, archiveTraitAction, previewTraitAction, computePreviewFromQuery } from '@/app/actions/traits'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

type SP = Record<string, string | string[] | undefined>
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? undefined

const AGGREGATIONS = ['count', 'sum', 'min', 'max', 'last', 'days_since'] as const

function fmtValue(v: number | null): string {
  if (v == null) return '—'
  return Number.isInteger(v) ? String(v) : v.toFixed(1)
}

export default async function TraitsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const error = one(sp.error)
  const previewParam = one(sp.preview)
  const db = getDb()

  if (!db) {
    return (
      <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
        <h1 className="text-base font-semibold text-ink">Traits</h1>
        <p className="mt-2 text-sm text-ink-faint">The lead database is not connected (DATABASE_URL is not set).</p>
      </main>
    )
  }

  let traits: Awaited<ReturnType<typeof listTraits>> = []
  let needsMigration = false
  try {
    await ensureTraitFieldsRegistered(db)
    traits = await listTraits(db, { includeArchived: false })
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }

  const preview = previewParam ? await computePreviewFromQuery(previewParam).catch(() => null) : null

  return (
    <main className="mx-auto max-w-shell px-4 py-6 sm:px-6">
      <header className="mb-6">
        <h1 className="text-base font-semibold tracking-[-0.01em] text-ink">Traits</h1>
        <p className="mt-1 text-sm text-ink-faint">Per-lead numbers computed once from events, used in segments, scores and the lead profile.</p>
      </header>

      {error ? <p className="mb-4 rounded-control border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad">{error}</p> : null}

      {needsMigration ? (
        <Card className="p-4">
          <p className="text-sm text-ink-faint">Needs migration 0033 — it runs on the next production deploy.</p>
        </Card>
      ) : (
        <>
          <SectionHeader title="Defined traits" meta={`${traits.length}`} />
          <Card className="mb-8 overflow-hidden">
            {traits.length === 0 ? (
              <EmptyNote>No traits defined yet.</EmptyNote>
            ) : (
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-2xs uppercase tracking-[0.04em] text-ink-faint">
                    <th className="px-4 py-2 font-medium">Key</th>
                    <th className="px-4 py-2 font-medium">Label</th>
                    <th className="px-4 py-2 font-medium">Entity</th>
                    <th className="px-4 py-2 font-medium">Aggregation</th>
                    <th className="px-4 py-2 font-medium">Window</th>
                    <th className="px-4 py-2 font-medium">Last computed</th>
                    <th className="px-4 py-2 font-medium"></th>
                  </tr>
                </thead>
                <tbody>
                  {traits.map((t) => (
                    <tr key={t.key} className="border-b border-line last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{t.key}</td>
                      <td className="px-4 py-2">{t.label}</td>
                      <td className="px-4 py-2"><Pill tone="neutral">{t.entity}</Pill></td>
                      <td className="px-4 py-2">{t.definition.aggregation}</td>
                      <td className="px-4 py-2">{t.definition.window_days ? `${t.definition.window_days}d` : 'all time'}</td>
                      <td className="px-4 py-2 text-ink-faint">{t.last_computed_at ? new Date(t.last_computed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : 'never'}</td>
                      <td className="px-4 py-2 text-right">
                        <form action={archiveTraitAction}>
                          <input type="hidden" name="key" value={t.key} />
                          <button type="submit" className="text-xs text-ink-faint hover:text-bad">Archive</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <SectionHeader title="New trait" />
          <Card className="mb-8 p-4">
            <form action={defineTraitAction} className="grid grid-cols-2 gap-3 text-sm">
              <label className="flex flex-col gap-1">
                Key (slug)
                <input name="key" required pattern="[a-z][a-z0-9_]{0,63}" className="rounded border border-line px-2 py-1" placeholder="replies_30d" />
              </label>
              <label className="flex flex-col gap-1">
                Label
                <input name="label" required maxLength={80} className="rounded border border-line px-2 py-1" placeholder="Replies (30d)" />
              </label>
              <label className="flex flex-col gap-1">
                Entity
                <select name="entity" className="rounded border border-line px-2 py-1">
                  <option value="company">Company</option>
                  <option value="contact">Contact</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Event type(s), comma-separated
                <input name="event_types" required className="rounded border border-line px-2 py-1" placeholder="reply_received" />
              </label>
              <label className="flex flex-col gap-1">
                Aggregation
                <select name="aggregation" className="rounded border border-line px-2 py-1">
                  {AGGREGATIONS.map((a) => (
                    <option key={a} value={a}>{a}</option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                Prop (for sum/min/max/last)
                <input name="prop" className="rounded border border-line px-2 py-1" placeholder="minutes" />
              </label>
              <label className="flex flex-col gap-1">
                Window (days, blank = all time)
                <input name="window_days" type="number" min={1} className="rounded border border-line px-2 py-1" placeholder="30" />
              </label>
              <div />
              <label className="flex flex-col gap-1">
                Filter prop path (optional)
                <input name="filter_path" className="rounded border border-line px-2 py-1" placeholder="url" />
              </label>
              <label className="flex flex-col gap-1">
                Filter op / value
                <div className="flex gap-2">
                  <select name="filter_op" className="rounded border border-line px-2 py-1">
                    <option value="is">is</option>
                    <option value="contains">contains</option>
                  </select>
                  <input name="filter_value" className="flex-1 rounded border border-line px-2 py-1" placeholder="/pricing" />
                </div>
              </label>
              <div className="col-span-2 flex gap-2 pt-2">
                <button formAction={previewTraitAction} className="rounded border border-line px-3 py-1.5 text-ink-muted hover:bg-canvas">Preview on 5 leads</button>
                <button type="submit" className="rounded bg-accent px-3 py-1.5 text-white">Save trait</button>
              </div>
            </form>
          </Card>

          {preview ? (
            <>
              <SectionHeader title="Preview (5 sample leads)" />
              <Card className="p-4">
                {preview.sample.length === 0 ? (
                  <EmptyNote>No leads to preview against yet.</EmptyNote>
                ) : (
                  <table className="w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-2xs uppercase tracking-[0.04em] text-ink-faint">
                        <th className="px-2 py-1 font-medium">{preview.entity === 'company' ? 'Company' : 'Contact'}</th>
                        <th className="px-2 py-1 font-medium">Value</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.sample.map((r) => (
                        <tr key={r.id} className="border-b border-line last:border-0">
                          <td className="px-2 py-1">{r.label}</td>
                          <td className="px-2 py-1">{fmtValue(r.value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
            </>
          ) : null}
        </>
      )}
    </main>
  )
}
