import type { Db } from '@/lib/db/types'
import { isUndefinedTable } from '@/lib/db/errors'

/**
 * Plan 1.15: the "get set up" checklist on the Overview page. `evaluate()` is
 * the pure part (unit-tested on its own, no DB or env involved): given what
 * the database and environment already say, which items are done, open, or
 * not built yet. `readChecklistInputs()` is the only part that touches the
 * database, and it is deliberately tolerant of tables that don't exist yet
 * (a fresh database, or a preview that never migrates) — each read many be
 * "not yet" rather than a crash.
 */

export interface ChecklistInputs {
  instantlyConnected: boolean
  webhookReceivingRecently: boolean
  agentKeysAdded: boolean
  leadsImported: boolean
  campaignProfileReviewed: boolean
  /** Whether lp.segments exists at all (a migration not yet applied on this deploy). */
  segmentsTableExists: boolean
  firstSegmentCreated: boolean
}

export type ChecklistStatus = 'done' | 'open' | 'coming_soon'

export interface ChecklistItem {
  id: string
  label: string
  status: ChecklistStatus
  href: string
}

/** The pure function: inputs in, checklist out. No I/O. */
export function evaluateChecklist(inputs: ChecklistInputs): ChecklistItem[] {
  return [
    { id: 'instantly', label: 'Connect Instantly', status: inputs.instantlyConnected ? 'done' : 'open', href: '/settings' },
    {
      id: 'webhook',
      label: 'Instantly webhook is sending events',
      status: inputs.webhookReceivingRecently ? 'done' : 'open',
      href: '/settings',
    },
    { id: 'agent_keys', label: 'Add agent keys', status: inputs.agentKeysAdded ? 'done' : 'open', href: '/settings' },
    { id: 'leads', label: 'Import leads', status: inputs.leadsImported ? 'done' : 'open', href: '/leads' },
    {
      id: 'campaign_profile',
      label: 'Review your first campaign profile',
      status: inputs.campaignProfileReviewed ? 'done' : 'open',
      href: '/campaigns',
    },
    {
      id: 'segment',
      // A missing table reads the same as "not yet" -- it isn't an error state,
      // just an earlier step (the migration that creates it) not reached yet.
      label: 'Create your first segment',
      status: inputs.segmentsTableExists && inputs.firstSegmentCreated ? 'done' : 'open',
      href: '/leads',
    },
    { id: 'journey', label: 'Build your first journey', status: 'coming_soon', href: '#' },
  ]
}

/** Done when nothing is left open; an item not built yet ("coming soon") never blocks this. */
export function checklistComplete(items: ChecklistItem[]): boolean {
  return items.every((i) => i.status !== 'open')
}

async function tableExists(db: Db, qualifiedName: string): Promise<boolean> {
  try {
    await db.query(`select 1 from ${qualifiedName} limit 1`)
    return true
  } catch (e) {
    if (isUndefinedTable(e)) return false
    throw e
  }
}

async function countFrom(db: Db, sql: string): Promise<number> {
  try {
    const r = await db.query<{ n: number }>(sql)
    return r.rows[0]?.n ?? 0
  } catch (e) {
    if (isUndefinedTable(e)) return 0
    throw e
  }
}

/** Reads the real inputs from the database and environment. Never throws: a missing table reads as "not yet", not an error. */
export async function readChecklistInputs(db: Db | null): Promise<ChecklistInputs> {
  if (!db) {
    return {
      instantlyConnected: false,
      webhookReceivingRecently: false,
      agentKeysAdded: false,
      leadsImported: false,
      campaignProfileReviewed: false,
      segmentsTableExists: false,
      firstSegmentCreated: false,
    }
  }

  const instantlyConnected = Boolean(process.env.INSTANTLY_API_KEY?.trim()) || (await countFrom(db, `select count(*)::int as n from lp.secrets where key = 'instantly.api_key'`)) > 0

  const webhookReceivingRecently =
    (await countFrom(
      db,
      `select count(*)::int as n from lp.lead_events where source = 'instantly_webhook' and occurred_at > now() - interval '7 days'`,
    )) > 0

  // "Agent keys added": at least one agent actor has been granted a task kind,
  // which only happens once its key is in place and it has started working.
  const agentKeysAdded =
    (await countFrom(
      db,
      `select count(*)::int as n from lp.actors where kind = 'agent' and active and last_seen_at is not null`,
    )) > 0

  const leadsImported = (await countFrom(db, `select count(*)::int as n from lp.companies`)) > 0

  const campaignProfileReviewed = (await countFrom(db, `select count(*)::int as n from lp.campaign_profiles`)) > 0

  const segmentsTableExists = await tableExists(db, 'lp.segments')
  const firstSegmentCreated = segmentsTableExists ? (await countFrom(db, `select count(*)::int as n from lp.segments`)) > 0 : false

  return {
    instantlyConnected,
    webhookReceivingRecently,
    agentKeysAdded,
    leadsImported,
    campaignProfileReviewed,
    segmentsTableExists,
    firstSegmentCreated,
  }
}
