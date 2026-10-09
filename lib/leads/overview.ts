/** The Overview screen: where the leads stand. Every number is a count of stored rows. */
import type { Queryable } from '@/lib/db/types'
import { STAGES, type Stage } from './types'
import { loadReplyDesk } from './replies'
import { TOUCH_COMPANY_REL } from './queries'

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
  /** Emails verified valid, not do-not-contact, not on hold, and not yet in Instantly / sent / replied / bounced / rejected. */
  readyToSend: number
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

export async function loadOverview(db: Queryable): Promise<OverviewData> {
  const [stage, totals, tasks, agents, recent, desk] = await Promise.all([
    db.query<{ stage: Stage; n: number }>(`select stage, count(*)::int as n from lp.companies group by stage`),
    db.query<{
      companies: number; contacts: number; needs_research: number; research_queued: number; needs_verif_co: number
      unverified: number; ready: number; in_campaigns: number
    }>(
      `select
         (select count(*)::int from lp.companies) as companies,
         (select count(*)::int from lp.contacts where email_norm is not null) as contacts,
         (select count(*)::int from lp.companies where research_status in ('needs_research', 'failed')) as needs_research,
         (select count(*)::int from lp.companies where research_status in ('queued', 'researching')) as research_queued,
         (select count(distinct company_id)::int from lp.contacts where email_norm is not null and verification_status = 'unverified' and company_id is not null) as needs_verif_co,
         (select count(*)::int from lp.contacts where email_norm is not null and verification_status = 'unverified') as unverified,
         (select count(*)::int from lp.contacts where email_norm is not null and verification_status = 'valid' and not do_not_contact
             and status not in ('in-Instantly', 'sent', 'replied', 'bounced', 'rejected', 'do-not-contact', 'role-based-hold', 'needs-check')) as ready,
         (select count(distinct tc.co)::int from ${TOUCH_COMPANY_REL} tc) as in_campaigns`,
    ),
    db.query<{ active: number; queued: number; approvals: number }>(
      `select (select count(*)::int from lp.tasks where status in ('claimed', 'running')) as active,
              (select count(*)::int from lp.tasks where status = 'queued') as queued,
              (select count(*)::int from lp.approvals where status = 'pending') as approvals`,
    ),
    db.query<{ id: string; display_name: string; tasks: number }>(
      `select a.id, a.display_name, count(*)::int as tasks
         from lp.tasks t join lp.actors a on a.id = t.claimed_by
        where t.status in ('claimed', 'running') group by a.id, a.display_name order by tasks desc, a.id`,
    ),
    db.query<OverviewEvent>(
      `select e.id, e.at, e.actor, a.display_name as actor_name, e.kind, e.summary, e.entity_type, e.entity_id
         from lp.events e left join lp.actors a on a.id = e.actor order by e.at desc, e.id desc limit 5`,
    ),
    loadReplyDesk(db),
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
    inCampaigns: Number(t.in_campaigns),
    repliesWaiting: desk.filter((d) => d.bucket === 'needs_reply').length,
    interested: desk.filter((d) => d.bucket === 'interested').length,
    tasksActive: Number(tasks.rows[0].active),
    tasksQueued: Number(tasks.rows[0].queued),
    approvalsPending: Number(tasks.rows[0].approvals),
    agentsWorking: agents.rows.map((r) => ({ ...r, tasks: Number(r.tasks) })),
    recent: recent.rows,
  }
}
