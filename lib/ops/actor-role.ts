/**
 * Role gate for ops API keys minted for a PERSON (Phase 2 review, Viktor + Hermes).
 *
 * Deny by default. Agents (kind 'agent') and the runner ('system') carry no
 * dashboard role (lp.actors.role is humans-only, migration 0029) and are not
 * gated here: they keep working exactly as before, and the ops that need more
 * (merge, forget, retention, jobs, ...) still check the actor inside the op.
 *
 * But an ops key can also be minted for a HUMAN actor (lp.agent_keys.actor_id),
 * and then the key must not do more than that person can do in the dashboard:
 *  - a Viewer's key may run only the small read-only allowlist VIEWER_OPS;
 *  - an Editor's key may run every op except the owner-only ones (OWNER_OPS);
 *  - an Owner's key may run everything.
 * Any op not on either list (including ops added later) therefore needs Editor,
 * so a new write op is never open to a Viewer by accident. A human row that is
 * inactive or has no role is refused (fails closed).
 *
 * OWNER_OPS mirror the dashboard's owner-only server actions (actorFor('owner')
 * in app/actions: fields, scoring, tag renames/merges/styles, integrations,
 * jobs, merge, retention, settings).
 */
import type { Queryable } from '../db/types'
import { OpsError } from './core'

export type OpRole = 'viewer' | 'editor' | 'owner'

/**
 * Ops a Viewer's key may run. Nothing here changes shared data: the only writes
 * are feed_ack / mark_read, which mark the caller's OWN deliveries/notifications
 * as seen (without them a Viewer's feed items come back every 2 minutes).
 */
export const VIEWER_OPS: ReadonlySet<string> = new Set([
  'whoami', 'list_actors',
  'list_tasks', 'get_task', 'list_locks', 'recent_events',
  'get_approval', 'get_instantly_action',
  'memory_get', 'memory_search', 'inbox', 'feed', 'feed_ack', 'mark_read',
  'list_rule_sets', 'get_rule_set', 'lead_readiness',
  'page_comments', 'page_comment_get',
  'list_campaigns', 'get_campaign', 'list_campaign_statuses', 'list_campaign_leads', 'get_campaign_lead',
  'entity_history', 'recent_changes', 'list_fields',
  'is_suppressed', 'list_suppressions',
  'list_settings', 'get_setting', 'secret_status',
  'list_integrations', 'get_integration', 'latest_integration_metrics',
  'campaign_for_newsletter_list', 'campaign_for_utm_campaign',
  'list_jobs', 'get_job', 'job_runs',
  'recent_lead_events', 'list_event_types',
  'get_campaign_profile', 'list_profile_items', 'list_pools', 'sources_health',
  'validate_campaign_profile', 'export_campaign_profile',
  'list_score_models', 'get_score_model', 'lead_scores',
  'list_tags', 'tag_trends', 'merge_candidates',
  'count_tagged', // #87: counts leads with a tag before a change (read-only)
  'list_retention_policies', 'retention_preview',
  'list_segments', 'get_segment', 'segment_preview', 'segment_members', 'segment_stats',
  'geocode_place', 'leads_near', 'geo_status', // TAP-171 radius search (reads; geocode_place may cache a lookup)
  'lead_profile', 'list_traits', 'get_trait', 'trait_preview',
  'list_triggers', 'recent_trigger_fires',
  'journey_list', 'journey_get', 'journey_runs', 'journey_run_log', 'journey_validate',
])

/** Ops only an Owner's key may run (an Editor's key gets 403). */
export const OWNER_OPS: ReadonlySet<string> = new Set([
  // custom fields, scoring, tag renames/merges/styles (settings)
  'define_field', 'update_field', 'archive_field',
  'upsert_score_model', 'recompute_scores',
  'rename_tag', 'merge_tags', 'set_tag_style',
  // settings, integrations, jobs
  'put_setting', 'put_quiet_hours',
  'put_integration', 'report_integration_health', 'put_integration_snapshots',
  'put_job', 'set_job_enabled', 'run_job_now', 'claim_jobs', 'finish_job_run', 'reap_stale_jobs',
  'instantly_reconcile_run',
  // merge, delete-a-person, retention
  'merge', 'forget_contact', 'set_retention_policy', 'retention_sweep',
  'geo_load_centroids', 'geo_backfill', // TAP-171 one-time radius-search setup
])

/**
 * Editor ops named explicitly for clarity (any op not listed above already needs
 * Editor). change_tag arrives with #87 (tag one lead / selected leads / a segment).
 */
export const EDITOR_OPS_NAMED: ReadonlySet<string> = new Set(['change_tag', 'add_tag', 'remove_tag', 'suppress', 'unsuppress', 'update_entity'])

/** The role a human's key needs for `op`: Viewer for the read allowlist, Owner for OWNER_OPS, else Editor. */
export function requiredRole(op: string): OpRole {
  if (VIEWER_OPS.has(op)) return 'viewer'
  if (OWNER_OPS.has(op)) return 'owner'
  return 'editor'
}

const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 }

type ActorRow = { kind: string; role: string | null; active: boolean; has_role_col: boolean }

async function readActor(q: Queryable, actor: string): Promise<ActorRow | undefined> {
  // to_jsonb(a)->>'role' reads the column without failing on a database where
  // migration 0029 (which adds it) has not run yet; there the only human is the owner.
  return (await q.query<ActorRow>(
    `select a.kind, a.active, to_jsonb(a)->>'role' as role, to_jsonb(a) ? 'role' as has_role_col from lp.actors a where a.id = $1`,
    [actor],
  )).rows[0]
}

/** Throws OpsError 403 when `actor` is a human whose role is below what `op` needs. */
export async function checkOpRole(q: Queryable, actor: string, op: string): Promise<void> {
  const min = requiredRole(op)
  const row = await readActor(q, actor)
  if (!row || row.kind !== 'human' || !row.has_role_col) return
  const rank = row.role != null ? RANK[row.role] : undefined
  if (!row.active || rank === undefined || rank < RANK[min]) {
    throw new OpsError(`${op} needs ${min} access; this key belongs to a ${row.active ? (row.role ?? 'no-role') : 'deactivated'} account.`, 403)
  }
}

/**
 * True when `actor` is an Owner: the built-in 'owner' actor, or any active human
 * whose role is 'owner' (a second human Owner). Replaces literal actor === 'owner'
 * checks in the owner-only ops (merge, forget, retention, integrations, jobs, Instantly reconcile).
 */
export async function isOwnerActor(q: Queryable, actor: string): Promise<boolean> {
  if (actor === 'owner') return true
  const row = await readActor(q, actor)
  return !!row && row.kind === 'human' && row.active && row.has_role_col && row.role === 'owner'
}

/** Throws OpsError 403 unless `actor` is an Owner (see isOwnerActor). */
export async function requireOwnerActor(q: Queryable, actor: string, message: string): Promise<void> {
  if (!(await isOwnerActor(q, actor))) throw new OpsError(message, 403)
}

/**
 * Throws OpsError 403 unless `actor` is an Owner or the runner's own 'system'
 * actor. For ops that change how every lead is judged or run (job definitions,
 * score models, recomputing scores), where the nightly runner must keep working
 * but an agent key or an Editor must not.
 */
export async function requireOwnerOrSystem(q: Queryable, actor: string, message: string): Promise<void> {
  if (actor === 'system') return
  await requireOwnerActor(q, actor, message)
}

/**
 * True when `actor` is a person who may edit shared definitions: the built-in
 * 'owner' actor, or an active human whose role is editor or owner. Agents and
 * the runner are never editors (lp.actors.role is humans-only).
 */
export async function isEditorActor(q: Queryable, actor: string): Promise<boolean> {
  if (actor === 'owner') return true
  const row = await readActor(q, actor)
  return !!row && row.kind === 'human' && row.active && row.has_role_col && (row.role === 'editor' || row.role === 'owner')
}

/** Throws OpsError 403 unless `actor` is an Editor or Owner person (see isEditorActor). */
export async function requireEditorActor(q: Queryable, actor: string, message: string): Promise<void> {
  if (!(await isEditorActor(q, actor))) throw new OpsError(message, 403)
}
