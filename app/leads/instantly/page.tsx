import Link from 'next/link'
import { PageShell, BUTTON, DbNotConnected } from '@/components/app/PageShell'
import { Card, SectionHeader, EmptyNote, Pill } from '@/components/dashboard/primitives'
import { ConfirmAction } from '@/components/reports/ConfirmAction'
import { ActionNote } from '@/components/reports/Note'
import { TD, TH } from '@/components/reports/bits'
import { inputCls } from '@/components/ops/bits'
import { confirmAddLeadsAction, previewAddLeadsAction } from '@/app/actions/reports'
import { getDb } from '@/lib/db'
import { clientFromEnv } from '@/lib/instantly/client'
import { listCampaigns } from '@/lib/instantly/endpoints'
import { campaignStatus } from '@/lib/dashboard/metrics'
import { actionsEnabled } from '@/lib/instantly/writer'
import { EXCLUDE_WORDS, getAction, recentActions, type ActionRow, type PreviewLead } from '@/lib/instantly/add-leads'

export const dynamic = 'force-dynamic'

const STATUS_WORD: Record<ActionRow['status'], string> = {
  preview: 'Waiting for your OK',
  sending: 'Sending…',
  done: 'Done',
  failed: 'Failed, nothing added',
  unknown: 'Outcome unknown, check Instantly',
  cancelled: 'Cancelled',
}

function ids(v: string | string[] | undefined): number[] {
  const s = Array.isArray(v) ? v[0] : v
  return (s ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0)
}

function LeadTable({ leads, showReason }: { leads: PreviewLead[]; showReason?: boolean }) {
  return (
    <table className="w-full min-w-[560px] border-collapse">
      <thead className="border-b border-line">
        <tr>
          <th className={TH}>Lead</th>
          <th className={TH}>Email</th>
          <th className={TH}>{showReason ? 'Why not' : 'Ready as'}</th>
        </tr>
      </thead>
      <tbody>
        {leads.map((l) => (
          <tr key={l.contact_id} className="border-b border-line-soft last:border-0">
            <td className={TD}>
              <Link href={`/leads/${l.company_id}`} prefetch={false} className="hover:text-accent">{l.company}</Link>
              {l.first_name ? <div className="text-[11px] text-ink-faint">{[l.first_name, l.last_name].filter(Boolean).join(' ')}</div> : null}
            </td>
            <td className={`${TD} break-all`}>{l.email ?? <span className="text-unavailable">none</span>}</td>
            <td className={TD}>
              {showReason && l.excluded ? (
                <>
                  {EXCLUDE_WORDS[l.excluded] ?? l.excluded}
                  {l.park_reasons?.length ? <div className="text-[11px] text-ink-faint">{l.park_reasons.join(' · ')}</div> : null}
                </>
              ) : (
                <>
                  {l.tier === 'ready_personalized' ? 'Ready-personalized' : l.tier === 'ready_generic' ? 'Ready-generic' : l.verification_status}
                  {l.merge && Object.keys(l.merge).length ? (
                    <div className="text-[11px] text-ink-faint [overflow-wrap:anywhere]">{Object.entries(l.merge).map(([k, v]) => `${k}: ${v}`).join(' · ')}</div>
                  ) : null}
                </>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export default async function AddToInstantlyPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageShell title="Add to an Instantly campaign">
        <DbNotConnected what="Adding leads to Instantly" />
      </PageShell>
    )
  }
  const enabled = actionsEnabled()
  const actionId = ids(sp.action)[0]
  const action = actionId ? await getAction(db, actionId) : null
  const companyIds = ids(sp.companies)
  const recent = await recentActions(db, 8).catch(() => [])
  const readyN = action?.preview ? action.preview.ready.length : 0
  const leftN = action?.preview ? action.preview.excluded.length : 0

  let campaigns: { id: string; name: string; status: string }[] = []
  let campaignError: string | null = null
  if (!action) {
    const reader = clientFromEnv()
    if (!reader) campaignError = 'Instantly is not connected (INSTANTLY_API_KEY is not set).'
    else {
      try {
        const page = await listCampaigns(reader)
        campaigns = page.items
          .map((c) => ({ id: c.id, name: c.name ?? c.id, status: campaignStatus(c.status) }))
          .filter((c) => c.status !== 'completed')
      } catch (e) {
        campaignError = (e as Error).message
      }
    }
  }

  return (
    <PageShell
      title="Add to an Instantly campaign"
      meta="Preview first. Only leads Ready under the campaign’s lead rules (and not in Instantly yet) are sent, and only when you confirm."
      actions={<Link href="/leads" prefetch={false} className={BUTTON}>Back to Leads</Link>}
    >
      <ActionNote note={sp.note} tone={sp.tone} />
      {!enabled ? (
        <p className="mb-4 rounded-card border border-line bg-surface px-3 py-2 text-[12px] text-ink-muted">
          Instantly actions are off on this deploy (no Instantly key, or INSTANTLY_ACTIONS=off). You can preview, but nothing can be sent.
        </p>
      ) : null}

      {action ? (
        <>
          {/* counts of the stored preview lists (array lengths, not metrics) */}
          <Card className="mb-4 px-4 py-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-[12px] text-ink-faint">Campaign</p>
                <p className="text-[15px] font-semibold text-ink">{action.campaign_name ?? action.campaign_id}</p>
              </div>
              <Pill tone={action.status === 'done' ? 'good' : action.status === 'preview' ? 'accent' : action.status === 'failed' || action.status === 'unknown' ? 'bad' : 'neutral'}>
                {STATUS_WORD[action.status]}
              </Pill>
            </div>
            <p className="mt-3 text-[13px] text-ink">
              <strong className="font-numeric tabular-nums">{readyN}</strong> ready to add ·{' '}
              <span className="font-numeric tabular-nums">{leftN}</span> left out
            </p>
            {action.preview?.instantlyNote ? <p className="mt-1 text-[12px] text-ink-faint">{action.preview.instantlyNote}</p> : null}
            {action.preview?.rules ? (
              <p className="mt-1 text-[12px] text-ink-faint">
                Scored with the lead rules <Link href={`/rules/${action.preview.rules.id}`} className="text-accent">{action.preview.rules.name}</Link> (v{action.preview.rules.version})
                {action.preview.batch === 'role-inbox' ? ' · role-inbox batch: role inboxes only, tagged tab_batch=role-inbox' : ''}. Re-checked when you confirm.
              </p>
            ) : null}
            {action.status === 'preview' ? (
              <div className="mt-3">
                <ConfirmAction
                  action={confirmAddLeadsAction}
                  fields={{ action_id: String(action.id) }}
                  label={`Add ${readyN} to “${action.campaign_name ?? 'campaign'}”`}
                  confirmText={`Send ${readyN} leads to Instantly now? They start getting emails on the campaign’s schedule if it is active. Any already in Instantly are skipped.`}
                  confirmLabel="Add to Instantly"
                  tone="primary"
                  disabled={!enabled || !(readyN)}
                  disabledReason={!enabled ? 'Instantly actions are off on this deploy' : 'Nothing is ready to add'}
                />
              </div>
            ) : null}
            {action.result ? (
              <p className="mt-3 text-[12px] text-ink-muted">
                Instantly’s answer: {typeof action.result.leads_uploaded === 'number' ? `${action.result.leads_uploaded} added` : 'no count returned'}
                {action.error ? ` · ${action.error}` : ''}
              </p>
            ) : action.error ? (
              <p className="mt-3 text-[12px] text-bad">{action.error}</p>
            ) : null}
          </Card>
          {action.preview?.ready.length ? (
            <section className="mb-6">
              <SectionHeader title="Ready to add" />
              <Card className="overflow-x-auto"><LeadTable leads={action.preview.ready} /></Card>
            </section>
          ) : null}
          {action.preview?.excluded.length ? (
            <section className="mb-6">
              <SectionHeader title="Left out" meta="Not sent, with the reason" />
              <Card className="overflow-x-auto"><LeadTable leads={action.preview.excluded} showReason /></Card>
            </section>
          ) : null}
        </>
      ) : companyIds.length === 0 ? (
        <Card><EmptyNote>Select leads on the Leads screen, then choose “Add to Instantly”.</EmptyNote></Card>
      ) : (
        <Card className="mb-6 px-4 py-4">
          <p className="text-[13px] text-ink"><strong className="font-numeric tabular-nums">{companyIds.length}</strong> leads selected. Pick the campaign, then you’ll see exactly who would be added.</p>
          {campaignError ? <p className="mt-2 text-[12px] text-bad">{campaignError}</p> : null}
          <form action={previewAddLeadsAction} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="company_ids" value={companyIds.join(',')} />
            <select name="campaign_id" required className={`${inputCls} max-w-[420px]`} aria-label="Campaign" defaultValue="">
              <option value="" disabled>Choose a campaign…</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.status})</option>
              ))}
            </select>
            <CampaignNameField campaigns={campaigns} />
            <select name="batch" className={`${inputCls} max-w-[240px]`} aria-label="Batch" defaultValue="standard">
              <option value="standard">Named inboxes</option>
              <option value="role-inbox">Role-inbox batch (info@ etc., no-name copy)</option>
            </select>
            <button type="submit" className={BUTTON} disabled={campaigns.length === 0}>Preview</button>
          </form>
        </Card>
      )}

      {recent.length ? (
        <section>
          <SectionHeader title="Recent Instantly changes from this dashboard" />
          <Card className="divide-y divide-line-soft text-[13px]">
            {recent.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                <span>
                  {r.kind === 'add_leads' ? `Add ${r.contact_ids.length} leads` : r.kind === 'pause' ? 'Pause' : 'Resume'} · {r.campaign_name ?? r.campaign_id}
                </span>
                <span className="text-[12px] text-ink-faint">{STATUS_WORD[r.status]}</span>
              </div>
            ))}
          </Card>
        </section>
      ) : null}
    </PageShell>
  )
}

/** The campaign's name rides along so the preview and the activity log can say it. */
function CampaignNameField({ campaigns }: { campaigns: { id: string; name: string }[] }) {
  return <input type="hidden" name="campaign_names" value={JSON.stringify(Object.fromEntries(campaigns.map((c) => [c.id, c.name])))} />
}
