/**
 * Segment ops for agents and the dashboard (POST /api/ops {op, ...};
 * lib/ops/dispatch.ts spreads these in). Mirrors the lib/pools/ops.ts shape:
 * thin wrappers over lib/segments/store.ts + compile.ts that turn
 * DefinitionError / SegmentError into OpsError.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { DefinitionError, validateDefinition } from './definition.ts'
import { compileSegment, countSegment, matchingIds, sampleRows } from './compile.ts'
import { readback } from './readback.ts'
import { archiveSegment, createSegment, getSegment, listSegments, SegmentError, updateSegment } from './store.ts'
import { emitLeadEvents } from '../events/emit.ts'
import { allFields } from './fields.ts'
// lib/segments/ai.ts imports 'server-only' (it calls an external AI provider); load it on first use so
// this table (reached by dispatch.ts, which many test files import) stays importable anywhere, the
// same way lib/campaign-profiles/ops.ts lazy-loads suggest.ts for the same reason.
const aiModule = () => import('./ai.ts')
import { ensureTraitFieldsRegistered } from '../traits/register.ts'
import { segmentStats } from './stats.ts'
import { checkSegmentAlerts } from './alerts.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof SegmentError) throw new OpsError(e.message, e.status)
      if (e instanceof DefinitionError) throw new OpsError(e.message, 400)
      if (e instanceof Error && e.name === 'SegmentAiError') throw new OpsError(e.message, 400)
      throw e
    }
  }
}

function id(v: unknown, field = 'id'): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function idArray(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new OpsError(`${field} must be a non-empty array of ids`)
  return v.map((x) => id(x, field))
}

function rawDefinitionArg(a: Args): unknown {
  // segment_preview accepts either {definition: {...}} or the definition's own
  // keys spread at the top level, so a caller building a definition in pieces
  // doesn't have to wrap it -- both read the same way.
  if (a.definition != null) return a.definition
  const { entity, include, exclude } = a
  return { entity, include, exclude }
}

async function requireSegment(db: Db, segId: number) {
  const seg = await getSegment(db, segId)
  if (!seg) throw new OpsError(`No segment ${segId}.`, 404)
  return seg
}

export const SEGMENT_OPS: Record<string, Op> = {
  segment_fields: {
    args: '{}  -- the field registry (key, label, table, type, operators); for building a picker',
    run: async (db) => {
      await ensureTraitFieldsRegistered(db)
      return allFields()
    },
  },
  list_segments: {
    args: '{include_archived?, campaign_id?}',
    run: (db, _actor, a) => listSegments(db, { includeArchived: a.include_archived === true || a.include_archived === 'true', campaignId: a.campaign_id == null ? null : id(a.campaign_id, 'campaign_id') }),
  },
  get_segment: {
    args: '{id}',
    run: wrap(async (db, _actor, a) => {
      const seg = await requireSegment(db, id(a.id))
      return { ...seg, readback: readback(seg.definition) }
    }),
  },
  create_segment: {
    args: '{name, entity, definition, description?, kind?, campaign_id?}',
    run: wrap((db, actor, a) =>
      db.tx(
        (q) =>
          createSegment(q, actor, {
            name: String(a.name ?? ''),
            description: a.description == null ? null : String(a.description),
            kind: a.kind === 'static' ? 'static' : 'dynamic',
            campaign_id: a.campaign_id == null ? null : id(a.campaign_id, 'campaign_id'),
            entity: a.entity as 'company' | 'contact',
            definition: a.definition,
          }),
        actor,
      ),
    ),
  },
  update_segment: {
    args: '{id, name?, description?, campaign_id?, definition?}',
    run: wrap((db, actor, a) =>
      db.tx(
        (q) =>
          updateSegment(q, actor, id(a.id), {
            name: a.name === undefined ? undefined : String(a.name),
            description: a.description === undefined ? undefined : a.description == null ? null : String(a.description),
            campaign_id: a.campaign_id === undefined ? undefined : a.campaign_id == null ? null : id(a.campaign_id, 'campaign_id'),
            definition: a.definition,
          }),
        actor,
      ),
    ),
  },
  archive_segment: {
    args: '{id}',
    run: wrap((db, actor, a) => db.tx((q) => archiveSegment(q, actor, id(a.id)), actor)),
  },
  /** The live preview the builder debounces against: counts + readback + 10 sample
   *  rows for a definition that is NOT necessarily saved yet. */
  segment_preview: {
    args: '{definition} or {entity, include?, exclude?}',
    run: wrap(async (db, _actor, a) => {
      const def = validateDefinition(rawDefinitionArg(a))
      const compiled = await compileSegment(db, def)
      const [counts, sample] = await Promise.all([countSegment(db, compiled), sampleRows(db, compiled, 10)])
      return { entity: def.entity, counts, sample, readback: readback(def) }
    }),
  },
  /** Listed members: for a static segment, the stored rows; for a dynamic one, the
   *  live compiled match (so this op works the same regardless of kind). */
  segment_members: {
    args: '{id, limit?, offset?}',
    run: wrap(async (db, _actor, a) => {
      const seg = await requireSegment(db, id(a.id))
      const limit = a.limit == null ? 50 : Number(a.limit)
      const offset = a.offset == null ? 0 : Number(a.offset)
      if (seg.kind === 'static') {
        const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
        const { rows } = await db.query(
          `select ${col} as id, added_by, source, added_at from lp.segment_members where segment_id = $1 and ${col} is not null order by added_at desc limit $2 offset $3`,
          [seg.id, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
        )
        return { kind: 'static', entity: seg.entity, members: rows }
      }
      const compiled = await compileSegment(db, seg.definition)
      const ids = await matchingIds(db, compiled, { limit, offset })
      return { kind: 'dynamic', entity: seg.entity, members: ids.map((i) => ({ id: i })) }
    }),
  },
  segment_add_members: {
    args: '{id, company_ids?, contact_ids?}',
    run: wrap(async (db, actor, a) => {
      const seg = await requireSegment(db, id(a.id))
      if (seg.kind !== 'static') throw new OpsError('Only a static segment can have members added by hand; a dynamic segment\'s membership comes from its definition.')
      const ids = idArray(a[seg.entity === 'company' ? 'company_ids' : 'contact_ids'], seg.entity === 'company' ? 'company_ids' : 'contact_ids')
      return db.tx(async (q) => {
        const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
        let added = 0
        for (const memberId of ids) {
          const { rowCount } = await q.query(
            `insert into lp.segment_members (segment_id, ${col}, added_by, source) values ($1, $2, $3, 'api')
             on conflict do nothing`,
            [seg.id, memberId, actor],
          )
          if (rowCount) added++
        }
        const events = ids.map((memberId) => ({
          type: 'segment_joined',
          company_id: seg.entity === 'company' ? memberId : null,
          contact_id: seg.entity === 'contact' ? memberId : null,
          source: 'ops_api',
          actor,
          props: { segment_id: seg.id, segment_name: seg.name },
        }))
        await emitLeadEvents(q, events)
        return { segment_id: seg.id, requested: ids.length, added }
      }, actor)
    }),
  },
  segment_remove_members: {
    args: '{id, company_ids?, contact_ids?}',
    run: wrap(async (db, actor, a) => {
      const seg = await requireSegment(db, id(a.id))
      if (seg.kind !== 'static') throw new OpsError('Only a static segment can have members removed by hand.')
      const ids = idArray(a[seg.entity === 'company' ? 'company_ids' : 'contact_ids'], seg.entity === 'company' ? 'company_ids' : 'contact_ids')
      return db.tx(async (q) => {
        const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
        const { rowCount } = await q.query(`delete from lp.segment_members where segment_id = $1 and ${col} = any($2::bigint[])`, [seg.id, ids])
        const events = ids.map((memberId) => ({
          type: 'segment_left',
          company_id: seg.entity === 'company' ? memberId : null,
          contact_id: seg.entity === 'contact' ? memberId : null,
          source: 'ops_api',
          actor,
          props: { segment_id: seg.id, segment_name: seg.name },
        }))
        await emitLeadEvents(q, events)
        return { segment_id: seg.id, requested: ids.length, removed: rowCount ?? 0 }
      }, actor)
    }),
  },
  /** Writes one lp.segment_snapshots row per live segment, for the (future) nightly
   *  runner job (plan 2.12's size-over-time). Safe to call more than once a day:
   *  the unique (segment_id, day) index makes a same-day re-run a no-op per segment. */
  segment_snapshot: {
    args: '{}',
    run: wrap(async (db, actor) => {
      const segs = await listSegments(db, { includeArchived: false })
      const results: { segment_id: number; written: boolean }[] = []
      for (const seg of segs) {
        const compiled = await compileSegment(db, seg.definition)
        const counts = await countSegment(db, compiled)
        const { rowCount } = await db.query(
          `insert into lp.segment_snapshots (segment_id, companies, contacts, sendable)
           values ($1, $2, $3, $4)
           on conflict (segment_id, taken_on) do nothing`,
          [seg.id, counts.companies, counts.contacts, counts.verified_sendable],
        )
        results.push({ segment_id: seg.id, written: Boolean(rowCount) })
      }
      // 2.12: a segment with alert_rule set gets checked against its last two snapshots
      // right after they're written -- same job, no separate scheduler entry.
      const alerts = await checkSegmentAlerts(db, actor)
      return { segments: segs.length, results, alerts }
    }),
  },
  /** Size-over-time + per-segment metrics for 2.12: companies/contacts/sendable history
   *  from lp.segment_snapshots, plus reply rate / meetings / avg score when those are
   *  available (gracefully omitted otherwise -- never a fake number). */
  segment_stats: {
    args: '{id, days?}  -- days: how much snapshot history to return (default 90)',
    run: wrap(async (db, _actor, a) => {
      const seg = await requireSegment(db, id(a.id))
      return segmentStats(db, seg, a.days == null ? 90 : Number(a.days))
    }),
  },
  /** "Describe it" (2.11): text -> a validated definition + readback, for agents and
   *  the builder's AI box alike. Never auto-saved -- the caller reviews/edits, then
   *  create_segment / update_segment saves it like any other definition. */
  segment_from_text: {
    args: '{text, campaign_id?}',
    run: wrap(async (_db, _actor, a) => {
      const text = String(a.text ?? '')
      void a.campaign_id // reserved: not yet used to bias the prompt
      const { segmentFromText } = await aiModule()
      return segmentFromText(text)
    }),
  },
}
