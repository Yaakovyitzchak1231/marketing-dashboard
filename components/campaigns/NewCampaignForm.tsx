import { BUTTON_PRIMARY } from '@/components/app/PageShell'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { INPUT, LABEL, Notice } from '@/components/campaigns/ui'

type Pool = { id: string; label: string }
type Source = { id: number; name: string; is_template: boolean }

/**
 * Step 1 of the guided new-campaign flow (/campaigns/new). Posts to
 * createCampaignAction with flow=wizard, which lands on the campaign's
 * Profile wizard (step 2). Viewers get a note and no form.
 */
export function NewCampaignForm({
  canEdit, pools, sources, error, action,
}: {
  canEdit: boolean
  pools: Pool[]
  sources: Source[]
  error?: string
  action: (f: FormData) => void | Promise<void>
}) {
  if (!canEdit) {
    return (
      <Card className="p-4 text-sm text-ink-muted">
        View-only access: viewers can look at campaigns but not create them. Ask an editor or the owner to start one.
      </Card>
    )
  }
  return (
    <div className="max-w-xl space-y-4">
      {error ? <Notice tone="bad">{error}</Notice> : null}
      <ol className="flex gap-4 text-xs text-ink-faint">
        <li className="text-ink"><span className="tabular-nums">1</span> · Create the campaign</li>
        <li><span className="tabular-nums">2</span> · Set up its profile</li>
      </ol>
      <section aria-labelledby="new-step1-h">
        <SectionHeader id="new-step1-h" title="Create the campaign" meta="Next you set up its industry, keywords and sources" />
        <Card className="p-4">
          <form action={action} className="space-y-3">
            <input type="hidden" name="flow" value="wizard" />
            <label className={LABEL}>Name<input name="name" required maxLength={120} className={INPUT} placeholder="e.g. Maryland jewelers, fall" /></label>
            <label className={LABEL}>Pool
              <select name="pool" className={INPUT} defaultValue={pools[0]?.id ?? 'jeweler'}>
                {pools.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
              </select>
            </label>
            <label className={LABEL}>Goal<input name="goal" maxLength={500} className={INPUT} placeholder="optional" /></label>
            <label className={LABEL}>Start from
              <select name="from_id" className={INPUT} defaultValue="">
                <option value="">Blank</option>
                {sources.map((c) => <option key={c.id} value={c.id}>{c.is_template ? 'Template: ' : 'Copy of: '}{c.name}</option>)}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs text-ink-muted"><input type="checkbox" name="with_leads" defaultChecked /> When copying, copy its leads too</label>
            <button className={BUTTON_PRIMARY}>Create and set up profile</button>
          </form>
        </Card>
      </section>
    </div>
  )
}
