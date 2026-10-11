/**
 * Ops for the full lead profile (plan 2.10): one read for agents (lead_profile)
 * plus add/remove on the file links card. Mirrors lib/segments/ops.ts's shape.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import { getLeadProfile } from './profile.ts'
import { addLeadFile, removeLeadFile, FilesError } from './files.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function id(v: unknown, field = 'id'): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new OpsError(`${field} must be a positive integer`)
  return n
}

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof FilesError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

export const LEAD_PROFILE_OPS: Record<string, Op> = {
  lead_profile: {
    args: '{company_id}  -- the whole 360 profile in one call: detail, milestones, reachability, segments, campaigns, files, score (if scoring is merged), engagement benchmarks',
    run: wrap(async (db, _actor, a) => {
      const profile = await getLeadProfile(db, id(a.company_id, 'company_id'))
      if (!profile) throw new OpsError(`No lead ${a.company_id}.`, 404)
      return profile
    }),
  },
  lead_files_add: {
    args: '{company_id, name, url, contact_id?, note?}  -- url is a link (Drive/Dropbox/public URL); no paid storage',
    run: wrap((db, actor, a) =>
      addLeadFile(db, actor, {
        company_id: id(a.company_id, 'company_id'),
        contact_id: a.contact_id == null ? null : id(a.contact_id, 'contact_id'),
        name: String(a.name ?? ''),
        url: String(a.url ?? ''),
        note: a.note == null ? null : String(a.note),
      }),
    ),
  },
  lead_files_remove: {
    args: '{id}',
    run: wrap((db, actor, a) => removeLeadFile(db, actor, id(a.id))),
  },
}
