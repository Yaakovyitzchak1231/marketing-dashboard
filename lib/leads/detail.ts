/** Everything the lead detail screen (/leads/[id]) shows, read in one place. */
import type { Queryable } from '@/lib/db/types'
import type { CompanyRow, ContactRow } from './types'

export interface CommentRow {
  id: number
  company_id: number | null
  task_id: number | null
  author: string
  author_name: string
  body: string
  kind: string
  mentions: string[]
  created_at: Date
}

export interface SourceRow { id: number; contact_id: number | null; kind: string; source_ref: string; url: string | null; observed_at: Date }
export interface EnrichmentRow {
  id: number; contact_id: number | null; field: string; value: string; confidence: string | null
  evidence_url: string | null; method: string; actor_id: string | null; actor_name: string | null; created_at: Date
}
export interface VerificationRow {
  id: number; contact_id: number | null; email: string; provider: string; result: string; verdict: string
  sub_result: string | null; cost_usd: number; run_id: number | null; checked_at: Date
}
export interface TouchRow {
  id: number; contact_id: number | null; email: string | null; campaign_name: string | null; event_type: string
  occurred_at: Date; source: string; payload: Record<string, unknown> | null
}
export interface HistoryRow {
  id: number; entity_type: 'company' | 'contact'; entity_id: number; field: string; old_value: string | null
  new_value: string | null; changed_by: string | null; changed_by_name: string | null; changed_at: Date; email: string | null
}
export interface LeadTaskRow {
  id: number; kind: string; title: string; status: string; claimed_by: string | null; assigned_to: string | null
  report: string | null; error: string | null; created_at: Date; updated_at: Date; finished_at: Date | null
}

export interface LeadDetail {
  company: CompanyRow
  contacts: ContactRow[]
  sources: SourceRow[]
  enrichment: EnrichmentRow[]
  verification: VerificationRow[]
  touches: TouchRow[]
  history: HistoryRow[]
  comments: CommentRow[]
  tasks: LeadTaskRow[]
  actors: { id: string; display_name: string; kind: string }[]
}

export async function getLeadDetail(db: Queryable, id: number): Promise<LeadDetail | null> {
  const co = await db.query<CompanyRow>(`select * from lp.companies where id = $1`, [id])
  const company = co.rows[0]
  if (!company) return null
  const [contacts, sources, enrichment, verification, touches, history, comments, tasks, actors] = await Promise.all([
    db.query<ContactRow>(
      `select * from lp.contacts where company_id = $1
        order by (verification_status = 'valid') desc, coalesce(is_role_address, false), id`,
      [id],
    ),
    db.query<SourceRow>(
      `select id, contact_id, kind, source_ref, url, observed_at from lp.sources where company_id = $1 order by observed_at desc, id desc`,
      [id],
    ),
    db.query<EnrichmentRow>(
      `select e.id, e.contact_id, e.field, e.value, e.confidence, e.evidence_url, e.method, e.actor_id,
              a.display_name as actor_name, e.created_at
         from lp.enrichment e left join lp.actors a on a.id = e.actor_id
        where e.company_id = $1 order by e.field, e.created_at desc`,
      [id],
    ),
    db.query<VerificationRow>(
      `select r.id, r.contact_id, r.email, r.provider, r.result, r.verdict, r.sub_result, r.cost_usd, r.run_id, r.checked_at
         from lp.verification_results r join lp.contacts ct on ct.id = r.contact_id
        where ct.company_id = $1 order by r.checked_at desc, r.id desc`,
      [id],
    ),
    db.query<TouchRow>(
      `select t.id, t.contact_id, t.email, t.campaign_name, t.event_type, t.occurred_at, t.source, t.payload
         from lp.campaign_touches t
        where t.company_id = $1 or t.contact_id in (select x.id from lp.contacts x where x.company_id = $1)
        order by t.occurred_at desc, t.id desc limit 200`,
      [id],
    ),
    db.query<HistoryRow>(
      `select h.id, h.entity_type, h.entity_id, h.field, h.old_value, h.new_value, h.changed_by,
              a.display_name as changed_by_name, h.changed_at, ct.email
         from lp.status_history h
         left join lp.actors a on a.id = h.changed_by
         left join lp.contacts ct on h.entity_type = 'contact' and ct.id = h.entity_id
        where (h.entity_type = 'company' and h.entity_id = $1)
           or (h.entity_type = 'contact' and h.entity_id in (select x.id from lp.contacts x where x.company_id = $1))
        order by h.changed_at desc, h.id desc limit 200`,
      [id],
    ),
    db.query<CommentRow>(
      `select c.id, c.company_id, c.task_id, c.author, coalesce(a.display_name, c.author) as author_name, c.body, c.kind,
              c.mentions, c.created_at
         from lp.comments c left join lp.actors a on a.id = c.author
        where c.company_id = $1 order by c.created_at, c.id`,
      [id],
    ),
    db.query<LeadTaskRow>(
      `select id, kind, title, status, claimed_by, assigned_to, report, error, created_at, updated_at, finished_at
         from lp.tasks where company_id = $1 order by created_at desc, id desc limit 50`,
      [id],
    ),
    db.query<{ id: string; display_name: string; kind: string }>(`select id, display_name, kind from lp.actors where active order by kind desc, id`),
  ])
  return {
    company,
    contacts: contacts.rows,
    sources: sources.rows,
    enrichment: enrichment.rows,
    verification: verification.rows,
    touches: touches.rows,
    history: history.rows,
    comments: comments.rows.map((c) => ({ ...c, mentions: c.mentions ?? [] })),
    tasks: tasks.rows,
    actors: actors.rows,
  }
}
