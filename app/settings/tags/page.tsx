import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'
import { TagPill } from '@/components/leads/pills'
import { listTags, tagTrends } from '@/lib/tags/store'
import { mergeTagsAction, renameTagAction, setTagStyleAction } from '@/app/actions/tags'

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
  try {
    ;[tags, trends] = await Promise.all([listTags(db), tagTrends(db, 8)])
  } catch (e) {
    if (/does not exist/i.test((e as Error).message ?? '')) needsMigration = true
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

          <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <SectionHeader title="Rename a tag" />
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
                  <button type="submit" className={primaryBtnCls}>
                    Rename
                  </button>
                </form>
              </Card>
            </div>
            <div>
              <SectionHeader title="Merge tags" />
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
                  <button type="submit" className={primaryBtnCls}>
                    Merge
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
