import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'
import { listFieldDefsSafe } from '@/lib/fields/registry'
import { FIELD_ENTITIES, FIELD_TYPES } from '@/lib/fields/registry'
import { listCampaigns } from '@/lib/campaigns/store'
import { defineFieldAction, archiveFieldAction } from '@/app/actions/fields'

export const dynamic = 'force-dynamic'

const TYPE_WORDS: Record<string, string> = {
  text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown', multi_select: 'Multi-select', url: 'URL', boolean: 'Yes/No',
}

export default async function FieldsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Fields" meta="Your own fields on a lead or a company">
        <DbNotConnected what="Fields" />
      </PageFrame>
    )
  }
  const [fieldsRead, campaigns] = await Promise.all([listFieldDefsSafe(db, { include_archived: true }), listCampaigns(db)])
  const { defs: fields, needsMigration } = fieldsRead
  const live = fields.filter((f) => !f.archived_at)
  const campaignName = new Map(campaigns.map((c) => [c.id, c.name]))

  return (
    <PageFrame
      title="Fields"
      meta="Define your own fields on a company or a contact -- store size, a rating, a trade show, anything. They show up wherever a lead is edited, and in segments once that engine reads them."
    >
      <Notice error={sp.error} saved={sp.saved} />

      {needsMigration ? (
        <Card className="p-4">
          <p className="text-sm text-ink-muted">Needs migration 0025 — it runs on the next production deploy.</p>
        </Card>
      ) : (
        <>
      <section className="mb-6">
        <SectionHeader title="Add a field" />
        <Card className="p-4">
          <form action={defineFieldAction} className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <select name="entity" className={inputCls} required defaultValue="">
              <option value="" disabled>
                On a...
              </option>
              {FIELD_ENTITIES.map((e) => (
                <option key={e} value={e}>
                  {e === 'company' ? 'Company' : 'Contact'}
                </option>
              ))}
            </select>
            <input name="key" placeholder="key (e.g. store_size)" className={`${inputCls} font-mono`} required />
            <input name="label" placeholder="Label shown in the UI" className={inputCls} required />
            <select name="type" className={inputCls} required defaultValue="">
              <option value="" disabled>
                Type...
              </option>
              {FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_WORDS[t]}
                </option>
              ))}
            </select>
            <input name="options" placeholder="Options, comma-separated (dropdown / multi-select only)" className={inputCls} />
            <select name="campaign_id" defaultValue="" className={inputCls}>
              <option value="">Every campaign</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  Only {c.name}
                </option>
              ))}
            </select>
            <div className="sm:col-span-2 lg:col-span-3">
              <button type="submit" className={primaryBtnCls}>
                Add field
              </button>
            </div>
          </form>
        </Card>
      </section>

      <section>
        <SectionHeader title={`Fields (${live.length})`} />
        <Card className="overflow-x-auto">
          {live.length === 0 ? (
            <EmptyNote>No custom fields yet.</EmptyNote>
          ) : (
            <table className="w-full min-w-[640px]">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>On</th>
                  <th className={TH}>Key</th>
                  <th className={TH}>Label</th>
                  <th className={TH}>Type</th>
                  <th className={TH}>Options</th>
                  <th className={TH}>Campaign</th>
                  <th className={TH} />
                </tr>
              </thead>
              <tbody>
                {live.map((f) => (
                  <tr key={f.id} className="border-b border-line last:border-0">
                    <td className={TD}>{f.entity === 'company' ? 'Company' : 'Contact'}</td>
                    <td className={`${TD} font-mono`}>{f.key}</td>
                    <td className={TD}>{f.label}</td>
                    <td className={TD}>{TYPE_WORDS[f.type]}</td>
                    <td className={`${TD} max-w-[220px] truncate`} title={f.options.join(', ')}>
                      {f.options.length ? f.options.join(', ') : '—'}
                    </td>
                    <td className={TD}>{f.campaign_id ? (campaignName.get(f.campaign_id) ?? `#${f.campaign_id}`) : 'All'}</td>
                    <td className={TD}>
                      <form action={archiveFieldAction}>
                        <input type="hidden" name="id" value={f.id} />
                        <button type="submit" className={btnCls}>
                          Archive
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
        </>
      )}
    </PageFrame>
  )
}
