import Link from 'next/link'
import { ConfirmAction } from '@/components/reports/ConfirmAction'
import { inputCls, btnCls } from '@/components/ops/bits'
import { decideInstantlyApprovalAction } from '@/app/actions/instantly-approvals'
import { EXCLUDE_WORDS, type ExcludeReason } from '@/lib/instantly/add-leads'
import type { GatePreview } from '@/lib/instantly/gate'

/**
 * One agent request to change Instantly, as it sits in "Needs your OK":
 * what would change (before -> after), the campaign, how many leads and a few
 * of them, who is left out and why. Approve opens a confirm line first; Reject
 * needs a reason. Nothing reaches Instantly until the confirm click.
 */
export function InstantlyApprovalCard({ approvalId, preview, enabled }: { approvalId: number; preview: GatePreview; enabled: boolean }) {
  const p = preview
  // Array lengths stored with the request; absent only on a malformed payload, which can't be approved.
  const readyN: number | null = typeof p.ready_count === 'number' ? p.ready_count : null
  const leftN: number | null = typeof p.excluded_count === 'number' ? p.excluded_count : null
  const campaign = p.campaign_name ?? p.campaign_id
  const reasons = Object.entries(p.excluded_by_reason ?? {}) as [ExcludeReason, number][]
  const verb = p.kind === 'add_leads' ? `Add ${readyN ?? 'unknown'} to “${campaign}”` : p.kind === 'pause' ? `Pause “${campaign}”` : `Resume “${campaign}”`
  const confirmText =
    p.kind === 'add_leads'
      ? `Send ${readyN ?? 'unknown'} leads to Instantly now? They start getting emails on the campaign’s schedule if it is active. Anyone who stopped qualifying since the request is dropped first.`
      : p.kind === 'pause'
        ? `Pause “${campaign}” in Instantly now? It stops sending until someone resumes it.`
        : `Resume “${campaign}” in Instantly now? It starts sending again on its schedule.`
  return (
    <div className="space-y-2" data-testid="instantly-approval">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
        <dt className="text-ink-faint">Campaign</dt>
        <dd className="min-w-0 break-words text-ink">{campaign}</dd>
        {p.kind === 'add_leads' ? (
          <>
            <dt className="text-ink-faint">Leads</dt>
            <dd className="tabular-nums text-ink">
              {readyN ?? 'unknown'} to add · {leftN ?? 'unknown'} left out
            </dd>
          </>
        ) : null}
      </dl>
      {p.reason ? <p className="text-xs leading-snug text-ink-muted">Why: {p.reason}</p> : null}
      {p.diff.length ? (
        <ul className="rounded-control border border-line-soft bg-canvas px-2.5 py-1.5 text-xs" aria-label="What changes">
          {p.diff.map((d) => (
            <li key={d.field} className="leading-snug">
              <span className="text-ink-faint">{d.field}:</span> <span className="text-ink-muted line-through decoration-ink-faint/60">{d.from}</span> → <span className="text-ink">{d.to}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {p.sample && p.sample.length ? (
        <div className="text-xs">
          <p className="text-ink-faint">First {p.sample.length} of {readyN ?? 'unknown'}</p>
          <ul className="mt-0.5 space-y-0.5">
            {p.sample.map((l) => (
              <li key={l.contact_id} className="min-w-0 truncate">
                <Link href={`/leads/${l.company_id}`} prefetch={false} className="text-ink hover:text-accent">{l.company}</Link>
                <span className="text-ink-faint"> · {[l.name, l.email].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {reasons.length ? (
        <p className="text-xs leading-snug text-ink-faint">Left out: {reasons.map(([r, n]) => `${n} ${EXCLUDE_WORDS[r]?.toLowerCase() ?? r}`).join(' · ')}</p>
      ) : null}
      {p.instantly_note ? <p className="text-xs leading-snug text-ink-faint">{p.instantly_note}</p> : null}
      {p.kind === 'add_leads' ? (
        <Link className="text-xs text-accent" prefetch={false} href={`/leads/instantly?action=${p.instantly_action_id}`}>See every lead</Link>
      ) : null}
      <div className="flex flex-wrap gap-2 pt-1">
        <ConfirmAction
          action={decideInstantlyApprovalAction}
          fields={{ approval_id: String(approvalId), decision: 'approved' }}
          label={`Approve: ${verb}`}
          confirmText={confirmText}
          confirmLabel="Approve and send"
          tone="primary"
          disabled={!enabled || (p.kind === 'add_leads' && !readyN)}
          disabledReason={!enabled ? 'Instantly actions are off on this deploy' : 'Nothing is ready to add'}
        />
      </div>
      <form action={decideInstantlyApprovalAction} className="flex flex-wrap gap-2">
        <input type="hidden" name="approval_id" value={approvalId} />
        <input type="hidden" name="decision" value="rejected" />
        <input name="note" required minLength={3} className={`${inputCls} min-w-0 flex-1`} placeholder="Why not? (required to reject)" aria-label="Reason for rejecting" />
        <button className={btnCls} type="submit">Reject</button>
      </form>
    </div>
  )
}
