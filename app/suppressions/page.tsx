import Link from 'next/link'
import { getDb } from '@/lib/db'
import { REASONS, REASON_WORDS, listSuppressions } from '@/lib/suppressions/store'
import { addSuppressionAction, importSuppressionsCsvAction, liftSuppressionAction } from '@/app/actions/suppressions'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'

export const dynamic = 'force-dynamic'

export default async function SuppressionsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Suppression list" meta="Emails and domains that never go to Instantly">
        <DbNotConnected what="The suppression list" />
      </PageFrame>
    )
  }
  const q = sp.q || null
  const reason = sp.reason || null
  const { rows, total } = await listSuppressions(db, { q, reason, page: sp.page ? Number(sp.page) : 1 })

  return (
    <PageFrame
      title="Suppression list"
      meta="Checked before every push to Instantly, and again right before the send. A campaign suppression applies only to that campaign; leave campaign blank for everywhere."
    >
      <Notice error={sp.error} saved={sp.saved} />

      <section className="mb-6">
        <SectionHeader title="Add" />
        <Card className="p-4">
          <form action={addSuppressionAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <input name="email" placeholder="email@example.com" className={inputCls} />
            <input name="domain" placeholder="or a whole domain, e.g. competitor.com" className={inputCls} />
            <select name="reason" defaultValue="manual" className={inputCls} required>
              {REASONS.map((r) => (
                <option key={r} value={r}>
                  {REASON_WORDS[r]}
                </option>
              ))}
            </select>
            <input name="campaign_id" type="number" placeholder="Campaign id (blank = all campaigns)" className={inputCls} />
            <input name="note" placeholder="Note (optional)" className={inputCls} />
            <input name="expires_at" type="date" className={inputCls} title="Expires (optional, blank = forever)" />
            <div className="sm:col-span-2 lg:col-span-3">
              <button type="submit" className={primaryBtnCls}>
                Add
              </button>
            </div>
          </form>
        </Card>
      </section>

      <section className="mb-6">
        <SectionHeader title="Import CSV" meta="Columns: email or domain, reason (optional), campaign_id (optional), note (optional)" />
        <Card className="p-4">
          <form action={importSuppressionsCsvAction} className="flex flex-col gap-3">
            <textarea name="csv_text" rows={4} placeholder={'email,reason\nbounced@old.com,bounced\ncompetitor.com,competitor'} className={`${inputCls} font-mono text-xs`} />
            <div className="flex flex-wrap items-center gap-3">
              <input name="csv_file" type="file" accept=".csv,text/csv" className="text-xs" />
              <select name="reason" defaultValue="manual" className={inputCls} style={{ maxWidth: 220 }}>
                {REASONS.map((r) => (
                  <option key={r} value={r}>
                    Default reason: {REASON_WORDS[r]}
                  </option>
                ))}
              </select>
              <button type="submit" className={btnCls}>
                Import
              </button>
              <Link href="/api/suppressions/export" className={btnCls}>
                Export CSV
              </Link>
            </div>
          </form>
        </Card>
      </section>

      <section>
        <SectionHeader title={`On the list (${total.toLocaleString('en-US')})`} />
        <form className="mb-3 flex flex-wrap gap-2" method="get">
          <input name="q" defaultValue={q ?? ''} placeholder="Search email or domain" className={inputCls} style={{ maxWidth: 260 }} />
          <select name="reason" defaultValue={reason ?? ''} className={inputCls} style={{ maxWidth: 200 }}>
            <option value="">Any reason</option>
            {REASONS.map((r) => (
              <option key={r} value={r}>
                {REASON_WORDS[r]}
              </option>
            ))}
          </select>
          <button type="submit" className={btnCls}>
            Filter
          </button>
        </form>
        <Card className="overflow-x-auto">
          {rows.length === 0 ? (
            <EmptyNote>Nothing suppressed{q || reason ? ' matching that filter' : ' yet'}.</EmptyNote>
          ) : (
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>Email / domain</th>
                  <th className={TH}>Scope</th>
                  <th className={TH}>Reason</th>
                  <th className={TH}>Source</th>
                  <th className={TH}>Note</th>
                  <th className={TH}>Added</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line last:border-0">
                    <td className={TD}>{r.email_norm ?? r.domain}</td>
                    <td className={TD}>{r.campaign_id ? `Campaign ${r.campaign_id}` : 'All campaigns'}</td>
                    <td className={TD}>{REASON_WORDS[r.reason]}</td>
                    <td className={TD}>{r.source}</td>
                    <td className={`${TD} max-w-[220px] truncate`} title={r.note ?? ''}>
                      {r.note ?? '—'}
                    </td>
                    <td className={TD}>{new Date(r.created_at).toLocaleDateString('en-US')}</td>
                    <td className={TD}>
                      <form action={liftSuppressionAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button type="submit" className={btnCls}>
                          Lift
                        </button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </section>
    </PageFrame>
  )
}
