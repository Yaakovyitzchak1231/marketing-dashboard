import { getDb } from '@/lib/db'
import { DbNotConnected, BUTTON, BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { inputCls } from '@/components/ops/bits'
import { Flash } from '@/components/seo/bits'
import { listSites, type SiteRow } from '@/lib/seo/store'
import { wpConfigFromEnv, wpMatchesSite } from '@/lib/seo/wordpress'
import { addSiteAction, runAuditAction, toggleSiteAction } from '@/app/actions/seo'

export const dynamic = 'force-dynamic'
type SP = Record<string, string | string[] | undefined>

export default async function SeoSites({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) return <DbNotConnected what="The SEO section" />
  let sites: SiteRow[] = []
  try {
    sites = await listSites(db)
  } catch {
    return <EmptyNote>Couldn&rsquo;t read the SEO tables. Run the database migrations.</EmptyNote>
  }
  const wp = wpConfigFromEnv()
  return (
    <div className="space-y-7">
      <Flash sp={sp} />
      <section>
        <SectionHeader title="Tracked sites" meta={`${sites.filter((s) => s.active).length} active`} />
        {sites.length === 0 ? (
          <EmptyNote>No sites yet.</EmptyNote>
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {sites.map((s) => (
                <li key={s.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between" data-testid="seo-site-row">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-ink">
                      {s.name} {s.active ? null : <Pill tone="neutral">paused</Pill>}
                    </p>
                    <p className="text-xs text-ink-faint">
                      <a className="underline" href={s.base_url} target="_blank" rel="noreferrer">{s.base_url.replace(/^https?:\/\//, '')}</a>
                      {' · '}
                      {[s.platform, s.host && `on ${s.host}`, s.campaign && `campaign: ${s.campaign}`].filter(Boolean).join(' · ') || 'no platform set'}
                    </p>
                    <p className="text-xs text-ink-faint">Pages audited: / {s.pages.join(' ')}</p>
                    <p className="text-xs text-ink-faint">
                      WordPress actions:{' '}
                      {s.platform === 'wordpress' ? (wpMatchesSite(wp, s.base_url) ? <span className="text-good">connected</span> : <span>not connected (set WP_SITE_URL, WP_USER, WP_APP_PASSWORD)</span>) : 'not WordPress, so fixes come as copy-paste steps'}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <form action={runAuditAction}>
                      <input type="hidden" name="site_id" value={s.id} />
                      <input type="hidden" name="return_to" value="/seo/sites" />
                      <button className={BUTTON} disabled={!s.active}>Run audit</button>
                    </form>
                    <form action={toggleSiteAction}>
                      <input type="hidden" name="site_id" value={s.id} />
                      <input type="hidden" name="active" value={s.active ? '0' : '1'} />
                      <input type="hidden" name="return_to" value="/seo/sites" />
                      <button className={BUTTON}>{s.active ? 'Pause' : 'Resume'}</button>
                    </form>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>

      <section>
        <SectionHeader title="Add a site" />
        <Card className="px-4 py-4">
          <form action={addSiteAction} className="grid gap-3 sm:grid-cols-2">
            <input type="hidden" name="return_to" value="/seo/sites" />
            <label className="text-xs text-ink-muted">
              Website address
              <input name="base_url" required placeholder="tapdash.co" className={`${inputCls} mt-1`} />
            </label>
            <label className="text-xs text-ink-muted">
              Name
              <input name="name" placeholder="TapDash for contractors" className={`${inputCls} mt-1`} />
            </label>
            <label className="text-xs text-ink-muted">
              Platform
              <select name="platform" defaultValue="wordpress" className={`${inputCls} mt-1`}>
                <option value="wordpress">WordPress</option>
                <option value="lovable">Lovable</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Host
              <select name="host" defaultValue="siteground" className={`${inputCls} mt-1`}>
                <option value="siteground">SiteGround</option>
                <option value="lovable">Lovable</option>
                <option value="">Other / not sure</option>
              </select>
            </label>
            <label className="text-xs text-ink-muted">
              Campaign
              <input name="campaign" placeholder="jewelers, builders, contractors…" className={`${inputCls} mt-1`} />
            </label>
            <label className="text-xs text-ink-muted">
              Key pages to audit (besides the home page)
              <input name="pages" placeholder="/jewelers/ /pricing/" className={`${inputCls} mt-1`} />
            </label>
            <div className="sm:col-span-2">
              <button className={BUTTON_PRIMARY}>Add site</button>
            </div>
          </form>
        </Card>
      </section>
    </div>
  )
}
