import Link from 'next/link'
import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'
import { TagPill } from '@/components/leads/pills'
import { listTags, tagTrends } from '@/lib/tags/store'
import { changeTagAction, mergeTagsAction, previewTagChangeAction, renameTagAction, setTagStyleAction } from '@/app/actions/tags'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

export default async function TagsSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Tags" meta="Manage, rename, merge and colour tags">
        <DbNotConnected what="Tags" />
      </PageFrame>
    )
  }

  let tags: Awaited<ReturnType<typeof listTags>> = []
  let trends: Awaited<ReturnType<typeof tagTrends>> = []
  let needsMigration = false
  let segments: { id: number; name: string }[] = []
  try {
    segments = (await db.query<{ id: number; name: string }>(`select id, name from lp.segments where archived_at is null order by name limit 200`)).rows
  } catch {
    segments = []
  }
  try {
    ;[tags, trends] = await Promise.all([listTags(db), tagTrends(db, 8)])
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }

  return (
    <PageFrame title="Tags" meta="Free tags on a lead, now with a count, a colour and a rename/merge that updates every lead at once.">
      <Notice error={sp.error} saved={sp.saved} />

      {needsMigration ? (
        <Card className="p-4">
          <p className="text-[13px] text-ink-muted">Needs migration 0031 — it runs on the next production deploy.</p>
        </Card>
      ) : (
        <>
          <section className="mb-6">
            <SectionHeader title="Tags" meta={`${tags.length} tag${tags.length === 1 ? '' : 's'}`} />
            {!tags.length ? (
              <EmptyNote>No tags yet.</EmptyNote>
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={TH}>Tag</th>
                      <th className={TH}>Count</th>
                      <th className={TH}>Description</th>
                      <th className={TH}>Style</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tags.map((t) => (
                      <tr key={t.tag} className="border-b border-line/60">
                        <td className={TD}>
                          <TagPill tag={t.tag} colour={t.colour} />
                        </td>
                        <td className={TD}>{t.count}</td>
                        <td className={TD}>{t.description ?? <span className="text-ink-faint">Not set</span>}</td>
                        <td className={TD}>
                          <form action={setTagStyleAction} className="flex flex-wrap items-center gap-1.5">
                            <input type="hidden" name="tag" value={t.tag} />
                            <input name="colour" type="text" placeholder="#4f7cff" defaultValue={t.colour ?? ''} className={`${inputCls} w-24`} />
                            <input name="description" type="text" placeholder="Description" defaultValue={t.description ?? ''} className={`${inputCls} w-40`} />
                            <button type="submit" className={btnCls}>
                              Save
                            </button>
                          </form>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>

          {sp.confirm ? <ConfirmTagChange sp={sp} /> : null}

          <section className="mb-6">
            <SectionHeader title="Change a tag on some leads" meta="Only the leads you pick change. Everyone else keeps the tag." />
            <Card className="p-4">
              <form action={previewTagChangeAction} className="flex flex-wrap items-end gap-2">
                <div>
                  <label className="mb-1 block text-[11px] text-ink-faint">Tag now</label>
                  <input name="from" required placeholder="hot" className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-ink-faint">Change to</label>
                  <input name="to" required placeholder="priority" className={inputCls} />
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-ink-faint">Which leads</label>
                  <select name="mode" defaultValue="selected" className={inputCls}>
                    <option value="one">One lead (its number)</option>
                    <option value="selected">Selected leads (numbers, comma-separated)</option>
                    <option value="segment">A segment (its number)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1 block text-[11px] text-ink-faint">Lead number(s) or segment</label>
                  <input name="target" required placeholder="592, 593" list="tag-segments" className={inputCls} />
                  <datalist id="tag-segments">
                    {segments.map((g) => (
                      <option key={g.id} value={String(g.id)}>
                        {g.name}
                      </option>
                    ))}
                  </datalist>
                </div>
                <button type="submit" className={primaryBtnCls}>
                  Next
                </button>
              </form>
              <p className="mt-2 text-[12px] text-ink-faint">For more than one lead you&apos;ll see how many leads will change and confirm first. One entry goes in the history, not one per lead.</p>
            </Card>
          </section>

          <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <SectionHeader title="Rename a tag everywhere" meta="Owner only. Changes every lead with this tag." />
              <Card className="p-4">
                <form action={renameTagAction} className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-faint">From</label>
                    <input name="from" required className={inputCls} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-faint">To</label>
                    <input name="to" required className={inputCls} />
                  </div>
                  <button type="submit" className={btnCls}>
                    Next
                  </button>
                </form>
              </Card>
            </div>
            <div>
              <SectionHeader title="Merge tags everywhere" meta="Owner only. Changes every lead with any of these tags." />
              <Card className="p-4">
                <form action={mergeTagsAction} className="flex flex-wrap items-end gap-2">
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-faint">Tags (comma-separated)</label>
                    <input name="tags" required placeholder="hot_lead, warm_lead" className={inputCls} />
                  </div>
                  <div>
                    <label className="mb-1 block text-[11px] text-ink-faint">Into</label>
                    <input name="into" required placeholder="engaged" className={inputCls} />
                  </div>
                  <button type="submit" className={btnCls}>
                    Next
                  </button>
                </form>
              </Card>
            </div>
          </section>

          <section>
            <SectionHeader title="Tag trends" meta="Tags added per week, last 8 weeks" />
            {!trends.length ? (
              <EmptyNote>No tag activity yet.</EmptyNote>
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={TH}>Week of</th>
                      <th className={TH}>Tag</th>
                      <th className={TH}>Added</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trends.map((t) => (
                      <tr key={`${t.week}-${t.tag}`} className="border-b border-line/60">
                        <td className={TD}>{t.week}</td>
                        <td className={TD}>{t.tag}</td>
                        <td className={TD}>{t.added}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
          </section>
        </>
      )}
    </PageFrame>
  )
}

type SP = Record<string, string | undefined>

/** The confirm step: shows exactly how many leads the change will touch, and applies it only with that count. */
function ConfirmTagChange({ sp }: { sp: SP }) {
  const n = Number(sp.count ?? '0')
  const leads = `${n} lead${n === 1 ? '' : 's'}`
  let what: string
  let action: (f: FormData) => Promise<void>
  let hidden: Record<string, string>
  if (sp.confirm === 'rename') {
    what = `Rename "${sp.from}" to "${sp.to}" on all ${leads}?`
    action = renameTagAction
    hidden = { from: sp.from ?? '', to: sp.to ?? '' }
  } else if (sp.confirm === 'merge') {
    what = `Merge ${sp.tags} into "${sp.into}" on ${leads}?`
    action = mergeTagsAction
    hidden = { tags: sp.tags ?? '', into: sp.into ?? '' }
  } else {
    what = `Change "${sp.from}" to "${sp.to}" on ${leads} (${sp.scope ?? 'selected leads'})?`
    action = changeTagAction
    hidden = { from: sp.from ?? '', to: sp.to ?? '', mode: sp.mode ?? '', target: sp.target ?? '' }
  }
  return (
    <section className="mb-6" data-testid="tag-confirm">
      <Card className="p-4">
        {n === 0 ? (
          <p className="text-[13px] text-ink-muted">No leads have that tag, so nothing would change.</p>
        ) : (
          <form action={action} className="flex flex-wrap items-center gap-3">
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <input type="hidden" name="expected_count" value={String(n)} />
            <p className="text-[13px] text-ink">{what}</p>
            <button type="submit" className={primaryBtnCls}>
              Yes, change {leads}
            </button>
            <Link href="/settings/tags" prefetch={false} className="text-[12.5px] text-ink-faint underline">
              Cancel
            </Link>
          </form>
        )}
      </Card>
    </section>
  )
}
