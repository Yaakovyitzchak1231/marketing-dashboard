/**
 * Suppression ops for agents (POST /api/ops {op, ...} and the dashboard's
 * server actions). See lib/suppressions/store.ts for the actual logic.
 */
import type { Db } from '../db/types.ts'
import { OpsError } from '../ops/core.ts'
import {
  SuppressionError,
  addSuppression,
  checkEmails,
  exportCsv,
  importCsv,
  liftSuppression,
  listSuppressions,
} from './store.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

function wrap(run: Op['run']): Op['run'] {
  return async (db, actor, a) => {
    try {
      return await run(db, actor, a)
    } catch (e) {
      if (e instanceof SuppressionError) throw new OpsError(e.message, e.status)
      throw e
    }
  }
}

const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v))

const RAW: Record<string, Op> = {
  suppress: {
    args: '{email? | domain?, reason, campaign_id? (null = global), note?, source?, expires_at?}',
    run: (db, actor, a) =>
      addSuppression(db, actor, {
        email: typeof a.email === 'string' ? a.email : null,
        domain: typeof a.domain === 'string' ? a.domain : null,
        reason: String(a.reason ?? ''),
        campaign_id: num(a.campaign_id),
        note: typeof a.note === 'string' ? a.note : null,
        source: typeof a.source === 'string' ? a.source : 'ops_api',
        expires_at: typeof a.expires_at === 'string' ? a.expires_at : null,
      }),
  },
  unsuppress: {
    args: '{id}  OR  {email? | domain?, campaign_id?}',
    run: (db, actor, a) =>
      liftSuppression(db, actor, {
        id: a.id == null ? undefined : Number(a.id),
        email: typeof a.email === 'string' ? a.email : null,
        domain: typeof a.domain === 'string' ? a.domain : null,
        campaign_id: num(a.campaign_id),
      }),
  },
  is_suppressed: {
    args: '{email}  OR  {emails: string[]}, campaign_id?  -> per-email {suppressed, by}',
    run: async (db, _actor, a) => {
      const emails = Array.isArray(a.emails) ? a.emails.map(String) : typeof a.email === 'string' ? [a.email] : []
      if (!emails.length) throw new OpsError('give email or emails')
      const checked = await checkEmails(db, emails, num(a.campaign_id))
      return a.email && !Array.isArray(a.emails) ? checked[String(a.email)] : checked
    },
  },
  list_suppressions: {
    args: '{q?, reason?, campaign_id?, include_lifted?, page?}',
    run: (db, _actor, a) =>
      listSuppressions(db, {
        q: typeof a.q === 'string' ? a.q : null,
        reason: typeof a.reason === 'string' ? a.reason : null,
        campaign_id: num(a.campaign_id),
        include_lifted: a.include_lifted === true || a.include_lifted === 'true',
        page: a.page == null ? 1 : Number(a.page),
      }),
  },
  import_suppressions_csv: {
    args: '{csv: string, reason? (default per-row or "manual"), source?, campaign_id?}',
    run: (db, actor, a) =>
      importCsv(db, actor, String(a.csv ?? ''), {
        reason: typeof a.reason === 'string' ? a.reason : undefined,
        source: typeof a.source === 'string' ? a.source : 'import',
        campaign_id: num(a.campaign_id),
      }),
  },
  export_suppressions_csv: {
    args: '{q?, reason?, campaign_id?, include_lifted?}  -> {csv: string}',
    run: async (db, _actor, a) => ({
      csv: await exportCsv(db, {
        q: typeof a.q === 'string' ? a.q : null,
        reason: typeof a.reason === 'string' ? a.reason : null,
        campaign_id: num(a.campaign_id),
        include_lifted: a.include_lifted === true || a.include_lifted === 'true',
      }),
    }),
  },
}

export const SUPPRESSION_OPS: Record<string, Op> = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, { args: v.args, run: wrap(v.run) }]))
