import Link from 'next/link'
import { getDb } from '@/lib/db'
import { activeLocks, feed, listActors, pendingApprovals } from '@/lib/ops/queries'
import { decideApprovalAction, releaseLockAction } from '@/app/actions/ops'
import { AutoRefresh } from '@/components/ops/AutoRefresh'
import { Ago, DbNotConnected, PageFrame, btnCls } from '@/components/ops/bits'
import { Card, EmptyNote, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { ApprovalDecideForm } from '@/components/ops/ApprovalDecideForm'
import { currentRole } from '@/lib/auth/session'
import { InstantlyApprovalCard } from '@/components/ops/InstantlyApprovalCard'
import { isValueChangePayload } from '@/lib/edit/ask-change'
import { ActionNote } from '@/components/reports/Note'
import { actionsEnabled } from '@/lib/instantly/writer'
import { expireStaleInstantlyRequests, type GatePreview } from '@/lib/instantly/gate'

export const dynamic = 'force-dynamic'

const KINDS: { key: string; label: string }[] = [
  { key: '', label: 'Everything' },
  { key: 'task.', label: 'Tasks' },
  { key: 'webhook.', label: 'Instantly' },
  { key: 'verify', label: 'Verification' },
  { key: 'research', label: 'Research' },
  { key: 'engine', label: 'Find leads' },
  { key: 'approval.', label: 'Approvals' },
  { key: 'lock.', label: 'Checkouts' },
  { key: 'memory.', label: 'Memory' },
  { key: 'agent.', label: 'Pauses' },
]

type SP = Promise<{ actor?: string; kind?: string; before?: string; note?: string; tone?: string }>

function dayLabel(d: Date, tz: string): string {
  return d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'short', day: 'numeric' })
}

export default async function ActivityPage({ searchParams }: { searchParams: SP }) {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Activity" meta="Everything every agent and person did, in plain English">
        <DbNotConnected />
      </PageFrame>
    )
  }
  const sp = await searchParams
  const before = Number(sp.before) > 0 ? Number(sp.before) : null
  await expireStaleInstantlyRequests(db).catch(() => 0)
  const instantlyOn = actionsEnabled()
  const [events, approvals, locks, actors, role] = await Promise.all([
    feed(db, { actor: sp.actor || null, kind_prefix: sp.kind || null, limit: 150, before_id: before }),
    pendingApprovals(db),
    activeLocks(db),
    listActors(db),
    currentRole(),
  ])
  const now = new Date()
  const tz = process.env.DASHBOARD_TZ || 'America/New_York'
  const qs = (patch: Record<string, string | null>) => {
    const p = new URLSearchParams()
    const m = { actor: sp.actor ?? null, kind: sp.kind ?? null, ...patch }
    for (const [k, v] of Object.entries(m)) if (v) p.set(k, v)
    return p.toString() ? `/activity?${p}` : '/activity'
  }
  const chip = (on: boolean) => `rounded-full border px-2.5 py-1 text-[12px] ${on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface text-ink-muted hover:text-ink'}`
  let lastDay = ''

  return (
    <PageFrame title="Activity" meta="Everything every agent and person did, in plain English. Nothing outward happens without an approval here.">
      <AutoRefresh seconds={15} />
      <ActionNote note={sp.note} tone={sp.tone} />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap gap-1.5">
            {KINDS.map((k) => <Link key={k.key} className={chip((sp.kind ?? '') === k.key)} href={qs({ kind: k.key || null, before: null })}>{k.label}</Link>)}
          </div>
          <div className="mb-4 flex flex-wrap gap-1.5">
            <Link className={chip(!sp.actor)} href={qs({ actor: null, before: null })}>Everyone</Link>
            {actors.map((a) => <Link key={a.id} className={chip(sp.actor === a.id)} href={qs({ actor: a.id, before: null })}>{a.display_name}</Link>)}
          </div>
          <Card>
            {events.length ? (
              <ol>
                {events.map((e) => {
                  const day = dayLabel(new Date(e.at), tz)
                  const header = day !== lastDay ? day : null
                  lastDay = day
                  return (
                    <li key={e.id}>
                      {header ? <p className="border-b border-line-soft bg-canvas px-4 py-1.5 text-[11.5px] font-medium uppercase tracking-[0.05em] text-ink-faint">{header}</p> : null}
                      <div className="flex gap-3 border-b border-line-soft px-4 py-2.5 text-[13px] last:border-0">
                        <span className="w-[62px] shrink-0 pt-px text-[11.5px] tabular-nums text-ink-faint">
                          {new Date(e.at).toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' })}
                        </span>
                        <p className="min-w-0 leading-snug text-ink">
                          {e.task_id ? <Link href={`/team/${e.task_id}`} className="hover:text-accent">{e.summary}</Link> : e.summary}
                          {e.actor_kind === 'agent' && e.actor ? <span className="ml-1.5 text-[11px] text-ink-faint">{e.actor_name}</span> : null}
                        </p>
                      </div>
                    </li>
                  )
                })}
              </ol>
            ) : (
              <EmptyNote>No activity yet.</EmptyNote>
            )}
          </Card>
          {events.length === 150 ? (
            <p className="mt-3 text-center"><Link className={btnCls} href={qs({ before: String(events[events.length - 1].id) })}>Older</Link></p>
          ) : null}
        </div>

        <aside className="space-y-5">
          <section aria-labelledby="approvals">
            <SectionHeader id="approvals" title="Needs your OK" meta={<span className="tabular-nums">{approvals.length}</span>} />
            <Card className="divide-y divide-line-soft">
              {approvals.length ? approvals.map((a) => (
                <div key={a.id} className="space-y-2 p-3 text-[13px]">
                  <div className="flex items-center gap-2">
                    <Pill tone={a.instantly_action_id || a.action === 'spend' || a.action === 'destructive' ? 'warn' : 'accent'}>{a.instantly_action_id ? 'Instantly' : a.action}</Pill>
                    <span className="text-[11.5px] text-ink-faint">{a.requester_name} · <Ago at={a.created_at} now={now} /></span>
                  </div>
                  <p className="leading-snug text-ink">{a.summary}</p>
                  {isValueChangePayload(a.payload) ? (
                    <p className="text-[12px] text-ink-muted">
                      {a.payload.field_label}: <span className="tabular-nums">{a.payload.current}</span> stored → <span className="tabular-nums">{a.payload.proposed}</span> asked.{' '}
                      Approving records the decision; the number changes only when Instantly&rsquo;s data does.{' '}
                      <Link className="text-accent" href={`/leads/${a.payload.entity_id}?tab=engagement`}>Open the lead</Link>
                    </p>
                  ) : null}
                  {a.est_cost_usd != null ? <p className="text-[12px] tabular-nums text-ink-muted">Estimated cost ${Number(a.est_cost_usd).toFixed(2)}</p> : null}
                  {a.task_id ? <Link className="text-[12px] text-accent" href={`/team/${a.task_id}`}>Open the task</Link> : null}
                  {a.instantly_action_id ? (
                    <InstantlyApprovalCard approvalId={a.id} preview={a.payload as GatePreview} enabled={instantlyOn} />
                  ) : (
                    <ApprovalDecideForm approvalId={a.id} payload={a.payload} role={role} action={decideApprovalAction} />
                  )}
                </div>
              )) : <EmptyNote>Nothing is waiting for you.</EmptyNote>}
            </Card>
          </section>
          <section aria-labelledby="locks">
            <SectionHeader id="locks" title="Checked out" meta={<span className="tabular-nums">{locks.length}</span>} />
            <Card className="divide-y divide-line-soft">
              {locks.length ? locks.map((l) => (
                <div key={l.resource} className="flex items-start justify-between gap-2 px-3 py-2.5 text-[12.5px]">
                  <div className="min-w-0">
                    <p className="truncate text-ink">{l.resource}</p>
                    <p className="text-[11.5px] text-ink-faint">{l.holder_name}{l.note ? ` · ${l.note}` : ''} · since <Ago at={l.acquired_at} now={now} /></p>
                  </div>
                  <form action={releaseLockAction}>
                    <input type="hidden" name="resource" value={l.resource} />
                    <button className="text-[12px] text-ink-muted hover:text-bad" type="submit" title="Take it back (the agent loses the checkout)">Take back</button>
                  </form>
                </div>
              )) : <EmptyNote>Nothing is checked out.</EmptyNote>}
            </Card>
            <p className="mt-2 text-[11.5px] leading-snug text-ink-faint">An agent checks out a campaign, list or lead before changing it, like a library book; others wait. A checkout ends on its own if the agent goes quiet.</p>
          </section>
        </aside>
      </div>
    </PageFrame>
  )
}
