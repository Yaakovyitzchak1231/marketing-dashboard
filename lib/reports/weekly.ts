/**
 * The weekly one-pager: one object, rendered three ways (the /reports/weekly
 * page, JSON and markdown for agents). Every number is carried from Instantly
 * (last 7 days vs the 7 before), the lead database, or the ops board; a figure
 * nobody reported is null and prints as "no data".
 */
import type { Queryable } from '@/lib/db/types'
import type { DashboardData } from '@/lib/dashboard/types'
import { bestWorst, buildCostReport, MIN_CONTACTED_TO_RANK, type CostLine } from '@/lib/reports/costs'
import type { CampaignMeta } from '@/lib/reports/meta'
import { PENDING_APPROVAL_SQL } from '@/lib/ops/counters'
import { SEGMENT_LABEL } from '@/lib/reports/meta'
import { campaignRunway, formatDays, segmentRunway, type CampaignRunway, type SegmentPool, type SegmentRunway } from '@/lib/reports/runway'

export interface WeeklyNumbers {
  sent: number | null
  contacted: number | null
  replied: number | null
  interested: number | null
  meetings: number | null
  bounced: number | null
  replyRate: number | null
  bounceRate: number | null
}

export interface OpenItem {
  /** 'task' = a row on the Team board; 'reply' = a lead waiting on our answer; 'runway' = a campaign/segment low on leads. */
  kind: 'task' | 'reply' | 'runway' | 'approval'
  id: string
  title: string
  detail: string | null
  href: string | null
  taskId: number | null
  assignedTo: string | null
}

export interface WeeklyReport {
  generatedAt: string
  period: { start: string | null; end: string; timezone: string }
  instantlyConfigured: boolean
  dbConfigured: boolean
  thisWeek: WeeklyNumbers
  lastWeek: WeeklyNumbers | null
  angles: CostLine[]
  best: CostLine | null
  worst: CostLine | null
  rankNote: string
  campaignRunway: CampaignRunway[]
  segmentRunway: SegmentRunway[]
  openItems: OpenItem[]
  errors: string[]
}

const rate = (a: number | null, b: number | null) => (a === null || b === null || b <= 0 ? null : a / b)

function numbers(c: DashboardData['totals']['counts']): WeeklyNumbers {
  return {
    sent: c.sent,
    contacted: c.contacted,
    replied: c.replied,
    interested: c.positive,
    meetings: c.meetingsBooked,
    bounced: c.bounced,
    replyRate: rate(c.replied, c.contacted),
    bounceRate: rate(c.bounced, c.sent),
  }
}

export interface OpenTaskRow {
  id: number
  title: string
  status: string
  kind: string
  assigned_to: string | null
  claimed_by: string | null
}

export async function openTasks(q: Queryable, limit = 25): Promise<OpenTaskRow[]> {
  const { rows } = await q.query<OpenTaskRow>(
    `select id, title, status, kind, assigned_to, claimed_by from lp.tasks
      where status in ('queued', 'claimed', 'running', 'blocked', 'needs_approval') and kind <> 'find_leads'
      order by (status = 'blocked') desc, (status = 'needs_approval') desc, priority desc, id desc limit $1`,
    [limit],
  )
  return rows
}

export async function pendingApprovals(q: Queryable): Promise<{ id: number; summary: string }[]> {
  const { rows } = await q.query<{ id: number; summary: string }>(
    `select ap.id, ap.summary from lp.approvals ap where ${PENDING_APPROVAL_SQL} order by ap.id desc limit 10`,
  )
  return rows
}

const TASK_STATUS_WORD: Record<string, string> = {
  queued: 'waiting',
  claimed: 'claimed',
  running: 'in progress',
  blocked: 'blocked',
  needs_approval: 'needs your OK',
}

export function buildWeeklyReport(input: {
  data: DashboardData
  meta: Map<string, CampaignMeta>
  pools: SegmentPool[] | null
  tasks: OpenTaskRow[] | null
  approvals: { id: number; summary: string }[] | null
  dbConfigured: boolean
  /** Calendar days the Instantly numbers cover (the runway pace divisor). Default 7. */
  windowDays?: number
  now?: Date
}): WeeklyReport {
  const { data, meta } = input
  const thisWeek = numbers(data.totals.counts)
  const lastWeek = data.previous ? numbers(data.previous.counts) : null
  const cost = buildCostReport(data.campaigns, [], meta, { start: data.range.start ?? data.range.end, end: data.range.end })
  const bw = bestWorst(cost.angles)
  const rankNote =
    bw.ranked === 0
      ? `No angle had ${MIN_CONTACTED_TO_RANK}+ leads contacted this week (with its angle set), so there's no best or worst to call yet.`
      : bw.ranked === 1
        ? 'Only one angle had enough sends this week to rank.'
        : `Ranked by reply rate among ${bw.ranked} angles with ${MIN_CONTACTED_TO_RANK}+ leads contacted.`
  const cr = data.campaigns.map((c) => campaignRunway(c, meta.get(c.id), input.windowDays ?? 7))
  const sr = input.pools ? segmentRunway(input.pools, cr) : []

  const items: OpenItem[] = []
  for (const c of cr) {
    if (c.level === 'low' || c.level === 'out')
      items.push({
        kind: 'runway',
        id: `runway:${c.id}`,
        title: c.level === 'out' ? `${c.name} is out of leads` : `${c.name}: ${formatDays(c.days)} of leads left`,
        detail: c.remaining === null ? null : `${c.remaining.toLocaleString('en-US')} not yet contacted at about ${Math.round(c.pacePerDay ?? 0)} a day`,
        href: '/reports/runway',
        taskId: null,
        assignedTo: null,
      })
  }
  for (const s of sr) {
    if (s.level === 'low' || s.level === 'out')
      items.push({
        kind: 'runway',
        id: `runway-seg:${s.segment}`,
        title: `${SEGMENT_LABEL[s.segment]}: ${formatDays(s.days)} of leads left in total`,
        detail: `${s.ready.toLocaleString('en-US')} verified and unused, ${s.unverified.toLocaleString('en-US')} still to verify`,
        href: '/reports/runway',
        taskId: null,
        assignedTo: null,
      })
  }
  for (const r of data.repliedLeads.filter((x) => x.awaitingOurReply).slice(0, 10)) {
    items.push({
      kind: 'reply',
      id: `reply:${r.email}`,
      title: `Reply waiting: ${r.name ?? r.email}${r.company ? ` (${r.company})` : ''}`,
      detail: r.daysWaiting === null ? null : `waiting ${r.daysWaiting} day${r.daysWaiting === 1 ? '' : 's'}${r.campaignName ? `, ${r.campaignName}` : ''}`,
      href: '/replies',
      taskId: null,
      assignedTo: null,
    })
  }
  for (const a of input.approvals ?? []) {
    items.push({ kind: 'approval', id: `approval:${a.id}`, title: `Needs your OK: ${a.summary}`, detail: null, href: '/activity', taskId: null, assignedTo: null })
  }
  for (const t of input.tasks ?? []) {
    items.push({
      kind: 'task',
      id: `task:${t.id}`,
      title: t.title,
      detail: `${TASK_STATUS_WORD[t.status] ?? t.status}${t.claimed_by ? `, ${t.claimed_by} has it` : t.assigned_to ? `, assigned to ${t.assigned_to}` : ', unassigned'}`,
      href: `/team/${t.id}`,
      taskId: t.id,
      assignedTo: t.claimed_by ?? t.assigned_to,
    })
  }

  const errors = data.errors.map((e) => `${e.source}: ${e.message}`)
  if (!data.configured) errors.unshift('Instantly is not connected (INSTANTLY_API_KEY is not set), so sends, replies and meetings are not shown.')
  if (!input.dbConfigured) errors.unshift('The lead database is not connected (DATABASE_URL), so runway pools and open tasks are not shown.')

  return {
    generatedAt: (input.now ?? new Date()).toISOString(),
    period: { start: data.range.start, end: data.range.end, timezone: data.range.timezone },
    instantlyConfigured: data.configured,
    dbConfigured: input.dbConfigured,
    thisWeek,
    lastWeek,
    angles: cost.angles,
    best: bw.best,
    worst: bw.worst,
    rankNote,
    campaignRunway: cr,
    segmentRunway: sr,
    openItems: items,
    errors,
  }
}

// ---------------------------------------------------------------- markdown

const n = (v: number | null) => (v === null ? 'no data' : Math.round(v).toLocaleString('en-US'))
const pct = (v: number | null) => (v === null ? 'no data' : `${(v * 100).toFixed(1)}%`)

export function weeklyMarkdown(r: WeeklyReport): string {
  const L: string[] = []
  L.push(`# Weekly one-pager: ${r.period.start ?? '?'} to ${r.period.end}`)
  L.push('')
  L.push(`Generated ${r.generatedAt} (${r.period.timezone}). Numbers from Instantly and the lead database; "no data" means nobody reported it.`)
  if (r.errors.length) {
    L.push('')
    for (const e of r.errors) L.push(`> ${e}`)
  }
  L.push('')
  L.push('## This week')
  L.push('')
  L.push('| | This week | Week before |')
  L.push('|---|---:|---:|')
  const rows: [string, keyof WeeklyNumbers, boolean][] = [
    ['Emails sent', 'sent', false],
    ['New leads contacted', 'contacted', false],
    ['Replies', 'replied', false],
    ['Reply rate', 'replyRate', true],
    ['Interested', 'interested', false],
    ['Meetings booked', 'meetings', false],
    ['Bounces', 'bounced', false],
    ['Bounce rate', 'bounceRate', true],
  ]
  for (const [label, k, isPct] of rows) {
    const a = r.thisWeek[k]
    const b = r.lastWeek ? r.lastWeek[k] : null
    L.push(`| ${label} | ${isPct ? pct(a) : n(a)} | ${r.lastWeek ? (isPct ? pct(b) : n(b)) : 'no data'} |`)
  }
  L.push('')
  L.push('## Angles')
  L.push('')
  if (r.best) L.push(`- Best: **${r.best.label}** at ${pct(r.best.replyRate)} reply rate (${n(r.best.replied)} of ${n(r.best.contacted)} contacted)`)
  if (r.worst) L.push(`- Worst: **${r.worst.label}** at ${pct(r.worst.replyRate)} reply rate (${n(r.worst.replied)} of ${n(r.worst.contacted)} contacted)`)
  L.push(`- ${r.rankNote}`)
  if (r.angles.length) {
    L.push('')
    L.push('| Angle | Contacted | Replies | Reply rate | Interested | Meetings |')
    L.push('|---|---:|---:|---:|---:|---:|')
    for (const a of r.angles) L.push(`| ${a.label} | ${n(a.contacted)} | ${n(a.replied)} | ${pct(a.replyRate)} | ${n(a.interested)} | ${n(a.meetings)} |`)
  }
  L.push('')
  L.push('## Lead runway')
  L.push('')
  if (r.campaignRunway.length === 0 && r.segmentRunway.length === 0) L.push('No campaigns or lead pools to measure.')
  for (const c of r.campaignRunway) {
    L.push(`- ${c.name}: ${c.level === 'not_sending' ? 'not sending' : formatDays(c.days)}${c.remaining !== null ? ` (${n(c.remaining)} not yet contacted)` : ''}`)
  }
  for (const s of r.segmentRunway) {
    L.push(`- ${SEGMENT_LABEL[s.segment]} in total: ${formatDays(s.days)} (${n(s.ready)} verified unused + ${s.loadedRemaining === null ? 'no data' : n(s.loadedRemaining)} loaded; ${n(s.unverified)} to verify)`)
  }
  L.push('')
  L.push('## Open items')
  L.push('')
  if (r.openItems.length === 0) L.push('Nothing open.')
  for (const i of r.openItems) L.push(`- [ ] ${i.title}${i.detail ? ` (${i.detail})` : ''}`)
  L.push('')
  return L.join('\n')
}
