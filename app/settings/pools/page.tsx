import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'
import { listPools, type Pool } from '@/lib/pools/store'
import { createPoolAction, poolsPageRole, updatePoolAction } from '@/app/actions/pools'
import { isUndefinedTable } from '@/lib/db/errors'

export const dynamic = 'force-dynamic'

const label = 'mb-1 block text-xs font-medium text-ink-muted'

export default async function PoolsSettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Pools" meta="The industries a campaign can target">
        <DbNotConnected what="Pools" />
      </PageFrame>
    )
  }

  let pools: Pool[] = []
  let needsMigration = false
  try {
    pools = await listPools(db, { includeInactive: true })
  } catch (e) {
    if (isUndefinedTable(e)) needsMigration = true
    else throw e
  }
  const { isOwner } = await poolsPageRole()

  return (
    <PageFrame title="Pools" meta="The industries a campaign can target. Pools are rows here, not a hard-coded list: add one, then point a campaign at it.">
      <Notice error={sp.error} saved={sp.saved} />

      {needsMigration ? (
        <Card className="p-4">
          <p className="text-sm text-ink-muted">Needs migration 0020 — it runs on the next production deploy.</p>
        </Card>
      ) : (
        <>
          <section className="mb-6">
            <SectionHeader title="Pools" meta={`${pools.length} pool${pools.length === 1 ? '' : 's'}`} />
            {!pools.length ? (
              <EmptyNote>No pools yet.</EmptyNote>
            ) : (
              <Card className="overflow-x-auto p-0">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="border-b border-line">
                      <th className={TH}>Label</th>
                      <th className={TH}>ID</th>
                      <th className={TH}>Description</th>
                      <th className={TH}>Sort</th>
                      <th className={TH}>Active</th>
                      {isOwner ? <th className={TH}>Edit</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {pools.map((p) => (
                      <tr key={p.id} className="border-b border-line/60 align-top">
                        <td className={TD}>{p.label}</td>
                        <td className={TD}>
                          <code className="rounded bg-canvas px-1 font-numeric text-xs">{p.id}</code>
                        </td>
                        <td className={TD}>{p.description ?? <span className="text-ink-faint">Not set</span>}</td>
                        <td className={TD}>{p.sort}</td>
                        <td className={TD}>{p.active ? 'Yes' : <span className="text-ink-faint">No</span>}</td>
                        {isOwner ? (
                          <td className={TD}>
                            <form action={updatePoolAction} className="flex flex-wrap items-center gap-1.5">
                              <input type="hidden" name="id" value={p.id} />
                              <input name="label" defaultValue={p.label} aria-label="Label" className={`${inputCls} w-28`} />
                              <input name="description" defaultValue={p.description ?? ''} placeholder="Description" aria-label="Description" className={`${inputCls} w-40`} />
                              <input name="sort" defaultValue={String(p.sort)} aria-label="Sort" className={`${inputCls} w-16`} />
                              <label className="flex items-center gap-1 text-xs text-ink-muted">
                                <input type="checkbox" name="active" defaultChecked={p.active} />
                                Active
                              </label>
                              <button type="submit" className={btnCls}>
                                Save
                              </button>
                            </form>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
            )}
            <p className="mt-2 max-w-3xl text-xs leading-relaxed text-ink-faint">
              Inactive pools are not offered for new campaigns, but rows that already use them keep working. Renaming a pool&apos;s ID updates every
              campaign, company, segment and rule set that points at it.
            </p>
          </section>

          {isOwner ? (
            <section className="mb-6">
              <SectionHeader title="New pool" />
              <Card className="p-4">
                <form action={createPoolAction} className="grid max-w-2xl gap-3">
                  <div>
                    <label className={label} htmlFor="pool-label">
                      Label
                    </label>
                    <input id="pool-label" name="label" required maxLength={80} placeholder="Dental clinics" className={inputCls} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pool-id">
                      ID <span className="font-normal text-ink-faint">(optional — defaults to a slug from the label)</span>
                    </label>
                    <input id="pool-id" name="id" placeholder="dental_clinics" className={inputCls} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pool-desc">
                      Description
                    </label>
                    <input id="pool-desc" name="description" maxLength={1000} placeholder="Independent dental practices" className={inputCls} />
                  </div>
                  <div>
                    <label className={label} htmlFor="pool-sort">
                      Sort
                    </label>
                    <input id="pool-sort" name="sort" placeholder="100" className={`${inputCls} w-24`} />
                  </div>
                  <div>
                    <button type="submit" className={primaryBtnCls}>
                      Create pool
                    </button>
                  </div>
                </form>
              </Card>
            </section>
          ) : (
            <p className="text-xs text-ink-faint">Only owners can create or edit pools.</p>
          )}
        </>
      )}
    </PageFrame>
  )
}
