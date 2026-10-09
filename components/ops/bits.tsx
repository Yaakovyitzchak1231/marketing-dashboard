import Link from 'next/link'
import type { ReactNode } from 'react'
import { Pill, type PillTone } from '@/components/dashboard/primitives'
import { PageShell, DbNotConnected as AppDbNotConnected } from '@/components/app/PageShell'

/** "4m ago" with the exact time on hover. Server-rendered per request. */
export function Ago({ at, now = new Date() }: { at: Date | string | null; now?: Date }) {
  if (!at) return <span className="text-ink-faint">never</span>
  const d = typeof at === 'string' ? new Date(at) : at
  const s = Math.round((now.getTime() - d.getTime()) / 1000)
  let txt: string
  if (s < 0) {
    const f = -s
    txt = f < 60 ? `in ${f}s` : f < 3600 ? `in ${Math.round(f / 60)}m` : `in ${Math.round(f / 3600)}h`
  } else if (s < 45) txt = 'just now'
  else if (s < 3600) txt = `${Math.round(s / 60)}m ago`
  else if (s < 86400) txt = `${Math.round(s / 3600)}h ago`
  else txt = `${Math.round(s / 86400)}d ago`
  return (
    <time dateTime={d.toISOString()} title={d.toLocaleString('en-US', { timeZone: process.env.DASHBOARD_TZ || 'America/New_York' })}>
      {txt}
    </time>
  )
}

/** Online = seen in the last 10 minutes. A plain dot, not a glowing badge. */
export function Presence({ lastSeen, now = new Date() }: { lastSeen: Date | null; now?: Date }) {
  const online = lastSeen ? now.getTime() - new Date(lastSeen).getTime() < 10 * 60_000 : false
  return (
    <span
      aria-label={online ? 'active in the last 10 minutes' : 'not active recently'}
      title={online ? 'Active in the last 10 minutes' : 'Not active recently'}
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full ${online ? 'bg-good' : 'border border-line bg-canvas'}`}
    />
  )
}

const STATUS_TONE: Record<string, PillTone> = {
  queued: 'neutral',
  claimed: 'accent',
  running: 'accent',
  blocked: 'warn',
  needs_approval: 'warn',
  done: 'good',
  failed: 'bad',
  cancelled: 'neutral',
}
const STATUS_WORD: Record<string, string> = {
  queued: 'To do',
  claimed: 'Picked up',
  running: 'Working',
  blocked: 'Blocked',
  needs_approval: 'Needs your OK',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
}
export function TaskStatus({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'neutral'}>{STATUS_WORD[status] ?? status}</Pill>
}

export function kindLabel(kind: string): string {
  const k: Record<string, string> = {
    general: 'Task',
    research_company: 'Research',
    find_leads: 'Find leads',
    verify_contacts: 'Verify',
    review_reply: 'Reply',
    send_batch: 'Send',
  }
  return k[kind] ?? kind.replace(/_/g, ' ')
}

/** Kept for the ops screens' imports; the chrome is the shared PageShell. */
export function PageFrame({ title, meta, actions, children }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <PageShell title={title} meta={meta} actions={actions}>
      {children}
    </PageShell>
  )
}

export function DbNotConnected({ what = 'This screen' }: { what?: string }) {
  return <AppDbNotConnected what={what} />
}

export function ActorLink({ id, name }: { id: string | null; name: string | null }) {
  if (!id) return <span className="text-ink-faint">anyone</span>
  return (
    <Link href={`/agents/${id}`} className="text-ink hover:text-accent">
      {name ?? id}
    </Link>
  )
}

export const inputCls =
  'w-full rounded-card border border-line bg-surface px-2.5 py-1.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none'
export const btnCls =
  'inline-flex items-center justify-center rounded-card border border-line bg-surface px-3 py-1.5 text-[12.5px] font-medium text-ink hover:border-ink-faint'
export const primaryBtnCls =
  'inline-flex items-center justify-center rounded-card border border-accent bg-accent px-3 py-1.5 text-[12.5px] font-medium text-white hover:opacity-90'
