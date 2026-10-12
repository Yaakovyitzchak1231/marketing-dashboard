import type { Queryable } from '@/lib/db/types'
import { companyLists, listStaticLists } from '@/lib/segments/lists'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { BUTTON } from '@/components/app/PageShell'
import { addToListAction, removeFromListAction } from '@/app/actions/lists'
import { isUndefinedTable } from '@/lib/db/errors'

function tableMissing(e: unknown): boolean {
  return isUndefinedTable(e)
}

/**
 * The "Lists" card on a lead's page (plan 2.4): which static lists this lead
 * is in, with one-click remove, and a small form to add it to another list
 * (existing or brand new). Self-contained: its own data fetch (an honest
 * "Needs migration 0024" empty state when lp.segments isn't there yet, since
 * previews never migrate), its own two forms. Nothing else on the lead page
 * reads or writes through this file.
 */
export async function LeadListsCard({ db, companyId }: { db: Queryable; companyId: number }) {
  const returnTo = `/leads/${companyId}`
  let lists: { id: number; name: string }[] = []
  let allLists: { id: number; name: string }[] = []
  let unavailable = false
  try {
    ;[lists, allLists] = await Promise.all([companyLists(db, companyId), listStaticLists(db)])
  } catch (e) {
    if (!tableMissing(e)) throw e
    unavailable = true
  }
  const otherLists = allLists.filter((l) => !lists.some((x) => x.id === l.id))

  return (
    <section>
      <SectionHeader title="Lists" meta={unavailable ? undefined : `${lists.length}`} />
      <Card className="space-y-3 p-3">
        {unavailable ? (
          <EmptyNote>Needs migration 0024 — it runs on the next production deploy.</EmptyNote>
        ) : (
          <>
            {lists.length ? (
              <ul className="flex flex-wrap gap-1.5">
                {lists.map((l) => (
                  <li key={l.id} className="flex items-center gap-1 rounded-full border border-line bg-canvas/60 py-0.5 pl-2.5 pr-1 text-[12px] text-ink">
                    {l.name}
                    <form action={removeFromListAction}>
                      <input type="hidden" name="list_id" value={l.id} />
                      <input type="hidden" name="company_id" value={companyId} />
                      <input type="hidden" name="return_to" value={returnTo} />
                      <button type="submit" aria-label={`Remove from ${l.name}`} className="rounded-full px-1 text-ink-faint hover:bg-bad/10 hover:text-bad">
                        ×
                      </button>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-ink-faint">Not in any list yet.</p>
            )}
            <form action={addToListAction} className="flex flex-wrap items-center gap-1.5 border-t border-line-soft pt-2">
              <input type="hidden" name="company_id" value={companyId} />
              <input type="hidden" name="return_to" value={returnTo} />
              {otherLists.length ? (
                <select name="list_id" className="rounded-card border border-line bg-surface px-2 py-1 text-[12px] text-ink" defaultValue="">
                  <option value="">Pick a list…</option>
                  {otherLists.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              ) : null}
              <span className="text-[11px] text-ink-faint">or</span>
              <input name="new_list_name" placeholder="New list name" className="min-w-0 flex-1 rounded-card border border-line bg-surface px-2 py-1 text-[12px] text-ink" />
              <button type="submit" className={BUTTON}>
                Add
              </button>
            </form>
          </>
        )}
      </Card>
    </section>
  )
}
