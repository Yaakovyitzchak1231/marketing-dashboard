/**
 * Role gate for ops that change data (Phase 2 review, Viktor + Hermes).
 *
 * Agents (kind 'agent', 'system') carry no dashboard role (lp.actors.role is
 * humans-only, migration 0029) and keep working as before. But an ops key can
 * also be minted for a HUMAN actor (lp.agent_keys.actor_id), and then the key
 * must not do more than that person can do in the dashboard: a Viewer's key gets
 * 403 on every op below, an Editor's key on the owner-only ones. A human row
 * that is inactive or has no role is refused too (fails closed).
 *
 * The minimum roles mirror the dashboard's server actions (lib/auth/act.ts
 * actorFor): settings-type changes (fields, scoring, tag renames/merges/styles)
 * need owner; everything else editor. Merge, forget, retention and the Instantly
 * reconcile already require the 'owner' or 'system' actor inside their own ops.
 */
import type { Queryable } from '../db/types'
import { OpsError } from './core'

type MinRole = 'editor' | 'owner'

export const OP_MIN_ROLE: Record<string, MinRole> = {
  // custom fields (settings)
  define_field: 'owner', update_field: 'owner', archive_field: 'owner',
  // scoring (settings)
  upsert_score_model: 'owner', recompute_scores: 'owner',
  // tags: renaming/merging/styling is settings; tagging a lead is editing it
  rename_tag: 'owner', merge_tags: 'owner', set_tag_style: 'owner', add_tag: 'editor', remove_tag: 'editor',
  // imports, lead files
  import_csv: 'editor', lead_files_add: 'editor', lead_files_remove: 'editor',
  // segments, lists, traits, campaign sources
  create_segment: 'editor', update_segment: 'editor', archive_segment: 'editor',
  segment_add_members: 'editor', segment_remove_members: 'editor', segment_snapshot: 'editor',
  segment_from_text: 'editor',
  define_trait: 'editor', archive_trait: 'editor', recompute_traits: 'editor',
  campaign_add_from_segment: 'editor',
}

const RANK: Record<string, number> = { viewer: 0, editor: 1, owner: 2 }

/** Throws OpsError 403 when `actor` is a human whose role is below what `op` needs. */
export async function checkOpRole(q: Queryable, actor: string, op: string): Promise<void> {
  const min = OP_MIN_ROLE[op]
  if (!min) return
  // to_jsonb(a)->>'role' reads the column without failing on a database where
  // migration 0029 (which adds it) has not run yet; there the only human is the owner.
  const row = (await q.query<{ kind: string; role: string | null; active: boolean; has_role_col: boolean }>(
    `select a.kind, a.active, to_jsonb(a)->>'role' as role, to_jsonb(a) ? 'role' as has_role_col from lp.actors a where a.id = $1`,
    [actor],
  )).rows[0]
  if (!row || row.kind !== 'human' || !row.has_role_col) return
  const rank = row.role != null ? RANK[row.role] : undefined
  if (!row.active || rank === undefined || rank < RANK[min]) {
    throw new OpsError(`${op} needs ${min} access; this key belongs to a ${row.active ? (row.role ?? 'no-role') : 'deactivated'} account.`, 403)
  }
}
