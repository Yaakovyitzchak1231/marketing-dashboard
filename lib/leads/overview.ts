/** The Overview screen: where the leads stand. Every number is a count of stored rows. */
import type { Queryable } from '@/lib/db/types'
import { STAGES, type Stage } from './types'
import { replyDeskCounts } from './replies'
import { TOUCH_COMPANY_REL, readyContactSql } from './queries'
import { overviewReadiness, type OverviewReadiness } from '../rules/readiness'
import { PENDING_APPROVALS_COUNT_SQL } from '../ops/counters'
import { ROUTINE_EVENT_SQL } from '../ops/routine'

export interface OverviewEvent { id: number; at: Date; actor: string | null; actor_name: string | null; kind: string; summary: string; entity_type: string | null; entity_id: string | null }

export interface OverviewData {
  companies: number
  contacts: number
  byStage: Record<Stage, number>
  /** Companies with research_status needs_research or failed. */
  needsResearch: number
  researchQueued: number
  /** Companies with at least one unverified email; and the unverified emails themselves. */
  needsVerificationCompanies: number
  unverifiedContacts: number
  /** Companies with at least one sendable email (readyContactSql): the same set /leads?ready=yes lists. */
  readyToSend: number
  /** The sendable emails themselves (a company can have several). */
  readyToSendEmails: number
  /** Leads scored by the lead-rules evaluator under their pool's rules; null before migration 0010. */
  readiness: OverviewReadiness | null
  /** Companies with at least one Instantly event (campaign_touches). */
  inCampaigns: number
  repliesWaiting: number
  interested: number
  tasksActive: number
  tasksQueued: number
  approvalsPending: number
  agentsWorking: { id: string; display_name: string; tasks: number }[]
  recent: OverviewEvent[]
}

/**
 * A merged-away company or contact is a tombstone (merged_into, 0026): the lead lives on as
 * the row it was merged into. Counting tombstones double-counts every merged lead, which is
 * how the Overview reached 34,632. Migration 0026 is a hard requirement of the app (export,
 * segments, scoring and reconcile all filter on it without a fallback), so this does not check for it.
 */
const live = {
  co: 'merged_into is null',
  ct: 'merged_into is null',
  joinedCo: 'co.merged_into is null',
  joinedCt: 'ct.merged_into is null',
  coJoin: 'and exists (select 1 from lp.companies lc where lc.id = tc.co and lc.merged_into is null)',
}

export async function loadOverview(db: Queryable): Promise<OverviewData> {
  const [stage, totals, tasks, agents, recent, desk, readiness] = await Promise.all([
    db.query<{ stage: Stage; n: number }>(`select stage, count(*)::int as n from lp.companies where ${live.co} group by stage`),
    db.query<{
      companies: number; contacts: number; needs_research: number; research_queued: number; needs_verif_co: number
      unverified: number; ready: number; ready_emails: number; in_campaigns: number
    }>(
      `select
         (select count(*)::int from lp.companies where ${live.co}) as companies,
         (select count(*)::int from lp.contacts where email_norm is not null and ${live.ct}) as contacts,
         (select count(*)::int from lp.companies where ${live.co} and research_status in ('needs_research', 'failed')) as needs_research,
         (select count(*)::int from lp.companies where ${live.co} and research_status in ('queued', 'researching')) as research_queued,
         (select count(distinct ct.company_id)::int from lp.contacts ct join lp.companies co on co.id = ct.company_id
             where ct.email_norm is not null and ct.verification_status = 'unverified' and ${live.joinedCt} and ${live.joinedCo}) as needs_verif_co,
         (select count(*)::int from lp.contacts where email_norm is not null and ${live.ct} and verification_status = 'unverified') as unverified,
         (select count(distinct rc.company_id)::int from lp.contacts rc join lp.companies co on co.id = rc.company_id
             where ${readyContactSql('rc')} and ${live.joinedCo}) as ready,
         (select count(*)::int from lp.contacts rc join lp.companies co on co.id = rc.company_id
             where ${readyContactSql('rc')} and ${live.joinedCo}) as ready_emails,
         (select count(distinct tc.co)::int from ${TOUCH_COMPANY_REL} tc where true ${live.coJoin}) as in_campaigns`,
    ),
    db.query<{ active: number; queued: number; approvals: number }>(
      `select (select count(*)::int from lp.tasks where status in ('claimed', 'running')) as active,
              (select count(*)::int from lp.tasks where status = 'queued') as queued,
              ${PENDING_APPROVALS_COUNT_SQL} as approvals`,
    ),
    db.query<{ id: string; display_name: string; tasks: number }>(
      `select a.id, a.display_name, count(*)::int as tasks
         from lp.tasks t join lp.actors a on a.id = t.claimed_by
        where t.status in ('claimed', 'running') group by a.id, a.display_name order by tasks desc, a.id`,
    ),
    db.query<OverviewEvent>(
      `select e.id, e.at, e.actor, a.display_name as actor_name, e.kind, e.summary, e.entity_type, e.entity_id
         from lp.events e left join lp.actors a on a.id = e.actor where not ${ROUTINE_EVENT_SQL} order by e.at desc, e.id desc limit 5`,
    ),
    replyDeskCounts(db),
    overviewReadiness(db),
  ])
  const byStage = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>
  for (const r of stage.rows) byStage[r.stage] = Number(r.n)
  const t = totals.rows[0]
  return {
    companies: Number(t.companies),
    contacts: Number(t.contacts),
    byStage,
    needsResearch: Number(t.needs_research),
    researchQueued: Number(t.research_queued),
    needsVerificationCompanies: Number(t.needs_verif_co),
    unverifiedContacts: Number(t.unverified),
    readyToSend: Number(t.ready),
    readyToSendEmails: Number(t.ready_emails),
    readiness,
    inCampaigns: Number(t.in_campaigns),
    repliesWaiting: desk.needs_reply,
    interested: desk.interested,
    tasksActive: Number(tasks.rows[0].active),
    tasksQueued: Number(tasks.rows[0].queued),
    approvalsPending: Number(tasks.rows[0].approvals),
    agentsWorking: agents.rows.map((r) => ({ ...r, tasks: Number(r.tasks) })),
    recent: recent.rows,
  }
}
