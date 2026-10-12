/**
 * Plan 3.1 ops: journeys, versions, enrolment and the runner tick.
 *
 * Roles (lib/ops/actor-role.ts): a Viewer's key may read (journey_list,
 * journey_get, journey_runs, journey_run_log). Every write needs Editor (the
 * default for any op not on the viewer list). run_journeys is owner-or-system:
 * the journey_tick job calls it as `system` every minute.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { requireOwnerActor, requireOwnerOrSystem } from '../ops/actor-role.ts'
import { getSegment } from '../segments/store.ts'
import { companyIdsForSegment } from '../segments/match-companies.ts'
import { GraphError, validateGraph } from './graph.ts'
import { nodeKinds } from './nodes.ts'
import {
  JourneyError, approveCurrentVersion, getJourney, getVersionGraph, listJourneys, listVersions, publishVersion, setJourneyStatus,
  upsertJourney, type EntryMode,
} from './store.ts'
import { enrollLead, exitRuns, retryRun, runDueJourneys, type EnrollResult } from './runner.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

/** Most leads one journey_enroll call takes (a segment bigger than this needs several calls with offset). */
export const MAX_ENROLL_PER_CALL = 2000

function id(v: unknown, field: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}
function optId(v: unknown, field: string): number | null {
  return v == null || v === '' ? null : id(v, field)
}
function obj(v: unknown, field: string): Record<string, unknown> | undefined {
  if (v == null) return undefined
  if (typeof v !== 'object' || Array.isArray(v)) throw new OpsError(`${field} must be an object`)
  return v as Record<string, unknown>
}

async function wrap<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    if (e instanceof JourneyError) throw new OpsError(e.message, e.status)
    if (e instanceof GraphError) throw new OpsError(e.message, 400)
    throw e
  }
}

export const JOURNEY_OPS: Record<string, Op> = {
  journey_list: {
    args: '{campaign_id?, status?}  -- journeys with run counts by status',
    run: async (db, _actor, a) => ({
      journeys: await listJourneys(db, {
        campaign_id: optId(a.campaign_id, 'campaign_id'),
        status: typeof a.status === 'string' && a.status ? a.status : null,
      }),
      node_kinds: nodeKinds(),
    }),
  },
  journey_get: {
    args: '{journey_id, version?}  -- the journey, its versions, and the graph (current version unless version given)',
    run: async (db, _actor, a) => {
      const jid = id(a.journey_id, 'journey_id')
      const j = await getJourney(db, jid)
      if (!j) throw new OpsError('no journey with that id', 404)
      const version = optId(a.version, 'version') ?? j.current_version
      const { rows } = await db.query<{ status: string; n: number }>(
        'select status, count(*)::int as n from lp.journey_runs where journey_id = $1 group by status', [jid],
      )
      return {
        journey: j,
        versions: await listVersions(db, jid),
        version,
        graph: version == null ? null : await getVersionGraph(db, jid, version),
        counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      }
    },
  },
  journey_runs: {
    args: '{journey_id?, company_id?, contact_id?, status?, limit?}  -- runs, newest first, at most 500',
    run: async (db, _actor, a) => {
      const limit = Math.min(Math.max(Number(a.limit) || 100, 1), 500)
      const { rows } = await db.query(
        `select id, journey_id, version, company_id, contact_id, node_id, node_entered_at, status, next_run_at,
                entered_at, finished_at, source, trigger_fire_id, context, last_error
           from lp.journey_runs
          where ($1::bigint is null or journey_id = $1)
            and ($2::bigint is null or company_id = $2)
            and ($3::bigint is null or contact_id = $3)
            and ($4::text is null or status = $4)
          order by id desc limit $5`,
        [optId(a.journey_id, 'journey_id'), optId(a.company_id, 'company_id'), optId(a.contact_id, 'contact_id'),
          typeof a.status === 'string' && a.status ? a.status : null, limit],
      )
      return { runs: rows }
    },
  },
  journey_run_log: {
    args: '{run_id}  -- every step the run took, oldest first',
    run: async (db, _actor, a) => {
      const { rows } = await db.query(
        'select id, node_id, action, result, actor, at, version from lp.journey_steps_log where run_id = $1 order by id',
        [id(a.run_id, 'run_id')],
      )
      return { steps: rows }
    },
  },
  journey_upsert: {
    args: '{id?, name, campaign_id?, trigger_id?, entry_mode?: once|multiple, goal?, settings?}  -- create or edit (not the graph; see journey_publish). An omitted field keeps its value on edit; null clears campaign_id or trigger_id.',
    run: (db, actor, a) => wrap(() => upsertJourney(db, actor, {
      id: optId(a.id, 'id'),
      name: typeof a.name === 'string' ? a.name : '',
      // undefined = not sent (keep the stored value); null = clear it.
      campaign_id: a.campaign_id === undefined ? undefined : optId(a.campaign_id, 'campaign_id'),
      trigger_id: a.trigger_id === undefined ? undefined : optId(a.trigger_id, 'trigger_id'),
      entry_mode: typeof a.entry_mode === 'string' && a.entry_mode ? (a.entry_mode as EntryMode) : undefined,
      goal: obj(a.goal, 'goal'),
      settings: obj(a.settings, 'settings'),
    })),
  },
  journey_publish: {
    args: '{journey_id, graph: {start, nodes: [{id, kind, config?, next?, paths?: [{label, to}]}]}, note?}  -- validates, saves as the next version; runs in flight keep theirs',
    run: (db, actor, a) => wrap(() => publishVersion(db, actor, id(a.journey_id, 'journey_id'), a.graph,
      typeof a.note === 'string' && a.note.trim() ? a.note.trim() : null)),
  },
  journey_validate: {
    args: '{graph}  -- check a graph without saving it; returns {ok, errors}',
    run: async (_db, _actor, a) => {
      try {
        validateGraph(a.graph)
        return { ok: true, errors: [] }
      } catch (e) {
        if (e instanceof GraphError) return { ok: false, errors: e.errors }
        throw e
      }
    },
  },
  journey_set_status: {
    args: '{journey_id, status: draft|testing|live|paused|sunset}  -- going live is owner only',
    run: (db, actor, a) => wrap(async () => {
      const status = typeof a.status === 'string' ? a.status : ''
      if (status === 'live') await requireOwnerActor(db, actor, 'journey_set_status to live is owner only')
      return setJourneyStatus(db, actor, id(a.journey_id, 'journey_id'), status)
    }),
  },
  journey_approve: {
    args: '{journey_id}  -- owner only: approve the current version. Send-capable nodes do not run on a version nobody approved.',
    run: (db, actor, a) => wrap(async () => {
      await requireOwnerActor(db, actor, 'journey_approve is owner only')
      return approveCurrentVersion(db, actor, id(a.journey_id, 'journey_id'))
    }),
  },
  journey_retry: {
    args: '{run_id}  -- re-open an errored run; it resumes at the node that failed',
    run: (db, actor, a) => wrap(() => retryRun(db, actor, id(a.run_id, 'run_id'))),
  },
  journey_enroll: {
    args: '{journey_id, company_id? | contact_id? | company_ids?: [] | segment_id?, offset?, context?, source?: manual|api}  -- live journeys; testing too (a try on a few leads)',
    run: (db, actor, a) => wrap(async () => {
      const jid = id(a.journey_id, 'journey_id')
      const context = obj(a.context, 'context')
      const source = a.source === 'api' ? 'api' : 'manual'
      const leads: { company_id: number | null; contact_id: number | null }[] = []
      let fromSegment = false
      if (a.segment_id != null) {
        const seg = await getSegment(db, id(a.segment_id, 'segment_id'))
        if (!seg) throw new OpsError('no segment with that id', 404)
        const offset = Math.max(Number(a.offset) || 0, 0)
        const ids = await companyIdsForSegment(db, seg, offset + MAX_ENROLL_PER_CALL)
        for (const c of ids.slice(offset)) leads.push({ company_id: c, contact_id: null })
        fromSegment = true
      } else if (Array.isArray(a.company_ids)) {
        if (a.company_ids.length > MAX_ENROLL_PER_CALL) throw new OpsError(`at most ${MAX_ENROLL_PER_CALL} company_ids per call`)
        for (const c of a.company_ids) leads.push({ company_id: id(c, 'company_ids[]'), contact_id: null })
      } else {
        leads.push({ company_id: optId(a.company_id, 'company_id'), contact_id: optId(a.contact_id, 'contact_id') })
      }
      const results: (EnrollResult & { company_id: number | null; contact_id: number | null })[] = await db.tx(async (q) => {
        const out: (EnrollResult & { company_id: number | null; contact_id: number | null })[] = []
        for (const l of leads) {
          const r = await enrollLead(q, actor, jid, {
            ...l, context, source: fromSegment ? 'segment' : source, allow_testing: true,
          })
          out.push({ ...l, ...r })
        }
        return out
      }, actor)
      return {
        enrolled: results.filter((r) => r.enrolled).length,
        skipped: results.filter((r) => !r.enrolled).length,
        results: results.slice(0, 200),
        more: fromSegment && leads.length === MAX_ENROLL_PER_CALL,
      }
    }),
  },
  journey_exit: {
    args: '{run_id} | {journey_id, company_id? | contact_id?}, reason?  -- take open runs out by hand',
    run: (db, actor, a) => wrap(() => exitRuns(db, actor, {
      run_id: optId(a.run_id, 'run_id'),
      journey_id: optId(a.journey_id, 'journey_id'),
      company_id: optId(a.company_id, 'company_id'),
      contact_id: optId(a.contact_id, 'contact_id'),
    }, typeof a.reason === 'string' ? a.reason.slice(0, 200) : null)),
  },
  run_journeys: {
    args: '{limit?}  -- owner or the runner (system): enrol from trigger fires, advance due runs. Sends nothing.',
    run: async (db, actor, a) => {
      await requireOwnerOrSystem(db, actor, 'run_journeys is owner-only (the runner calls it as system).')
      return runDueJourneys(db, { limit: a.limit == null ? undefined : Number(a.limit), actor })
    },
  },
}
