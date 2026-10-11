/**
 * Data sources & sync health (plan 1.11): one honest row per source feeding
 * the lead platform, each computed from a stored row — never a guessed or
 * made-up number (house rule, AGENTS.md). A source whose last sync, 24h
 * volume or error is unknown reports null; the UI turns null into "No data
 * yet", never a 0 that looks like a real zero.
 *
 * Each reader is independent and never throws: one source's table being
 * briefly unreachable (or, on a preview database, a migration genuinely not
 * applied yet — previews never migrate) shows that one row as unknown rather
 * than taking the whole panel down (lib/setup/db-status.ts's pattern).
 */
import type { Db } from '@/lib/db/types'

export interface SourceHealth {
  id: string
  label: string
  /** When this source last did anything, or null if never / unknown. */
  last_event_at: string | null
  /** Volume in the last 24h, or null when this source has no stored volume to count. */
  count_24h: number | null
  /** Volume in the last 24h broken down by type/kind, or null when not applicable. */
  by_type_24h: Record<string, number> | null
  /** Failures in the last 24h, or null when this source does not track errors. */
  error_count_24h: number | null
  last_error: string | null
  last_error_at: string | null
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn()
  } catch {
    return fallback
  }
}

const EMPTY: Omit<SourceHealth, 'id' | 'label'> = {
  last_event_at: null,
  count_24h: null,
  by_type_24h: null,
  error_count_24h: null,
  last_error: null,
  last_error_at: null,
}

/** lp.lead_events grouped by `source` (instantly_webhook, instantly_reconcile, ...). */
async function leadEventSource(db: Db, id: string, label: string, source: string): Promise<SourceHealth> {
  return safe(async () => {
    const { rows } = await db.query<{ last_at: Date | null; type: string; n: number; n24: number }>(
      `select max(max(occurred_at)) over () as last_at, type, count(*)::int as n,
              count(*) filter (where occurred_at > now() - interval '24 hours')::int as n24
         from lp.lead_events where source = $1 group by type`,
      [source],
    )
    if (!rows.length) return { id, label, ...EMPTY }
    const by_type_24h: Record<string, number> = {}
    let count_24h = 0
    for (const r of rows) {
      if (r.n24 > 0) by_type_24h[r.type] = r.n24
      count_24h += r.n24
    }
    return { id, label, last_event_at: iso(rows[0]?.last_at), count_24h, by_type_24h, error_count_24h: null, last_error: null, last_error_at: null }
  }, { id, label, ...EMPTY })
}

/** lp.job_runs for one named job (instantly_reconcile today; any future runner job tomorrow). */
async function jobRunSource(db: Db, id: string, label: string, jobName: string): Promise<SourceHealth> {
  return safe(async () => {
    const { rows } = await db.query<{ last_at: Date | null; count_24h: number; error_count_24h: number }>(
      `select max(coalesce(finished_at, started_at)) as last_at,
              count(*) filter (where started_at > now() - interval '24 hours')::int as count_24h,
              count(*) filter (where started_at > now() - interval '24 hours' and status = 'failed')::int as error_count_24h
         from lp.job_runs where job_name = $1`,
      [jobName],
    )
    const r = rows[0]
    if (!r || !r.last_at) return { id, label, ...EMPTY }
    const err = await db.query<{ error: string | null; started_at: Date }>(
      `select error, started_at from lp.job_runs where job_name = $1 and status = 'failed' order by started_at desc limit 1`,
      [jobName],
    )
    return {
      id,
      label,
      last_event_at: iso(r.last_at),
      count_24h: r.count_24h,
      by_type_24h: null,
      error_count_24h: r.error_count_24h,
      last_error: err.rows[0]?.error ?? null,
      last_error_at: iso(err.rows[0]?.started_at),
    }
  }, { id, label, ...EMPTY })
}

/** lp.verification_runs (MillionVerifier / ZeroBounce waterfall). No dedicated error column; a halted run's reason lives in summary.halted. */
async function verifierSource(db: Db): Promise<SourceHealth> {
  const id = 'verifiers'
  const label = 'Email verifiers'
  return safe(async () => {
    const { rows } = await db.query<{ last_at: Date | null; count_24h: number; error_count_24h: number }>(
      `select max(coalesce(finished_at, created_at)) as last_at,
              count(*) filter (where created_at > now() - interval '24 hours')::int as count_24h,
              count(*) filter (where created_at > now() - interval '24 hours' and status = 'failed')::int as error_count_24h
         from lp.verification_runs`,
    )
    const r = rows[0]
    if (!r || !r.last_at) return { id, label, ...EMPTY }
    const err = await db.query<{ halted: string | null; created_at: Date }>(
      `select summary->>'halted' as halted, created_at from lp.verification_runs where status = 'failed' order by created_at desc limit 1`,
    )
    return {
      id,
      label,
      last_event_at: iso(r.last_at),
      count_24h: r.count_24h,
      by_type_24h: null,
      error_count_24h: r.error_count_24h,
      last_error: err.rows[0]?.halted ?? null,
      last_error_at: err.rows[0]?.halted ? iso(err.rows[0]?.created_at) : null,
    }
  }, { id, label, ...EMPTY })
}

/** lp.engine_runs: the "Find leads" map/crawl engine. */
async function engineSource(db: Db): Promise<SourceHealth> {
  const id = 'find_leads_engine'
  const label = 'Find-leads engine'
  return safe(async () => {
    const { rows } = await db.query<{ last_at: Date | null; count_24h: number; error_count_24h: number }>(
      `select max(coalesce(finished_at, started_at)) as last_at,
              count(*) filter (where started_at > now() - interval '24 hours')::int as count_24h,
              count(*) filter (where started_at > now() - interval '24 hours' and status = 'failed')::int as error_count_24h
         from lp.engine_runs`,
    )
    const r = rows[0]
    if (!r || !r.last_at) return { id, label, ...EMPTY }
    const err = await db.query<{ error: string | null; started_at: Date }>(
      `select error, started_at from lp.engine_runs where status = 'failed' order by started_at desc limit 1`,
    )
    return {
      id,
      label,
      last_event_at: iso(r.last_at),
      count_24h: r.count_24h,
      by_type_24h: null,
      error_count_24h: r.error_count_24h,
      last_error: err.rows[0]?.error ?? null,
      last_error_at: iso(err.rows[0]?.started_at),
    }
  }, { id, label, ...EMPTY })
}

/** lp.sources: where a company/contact's record came from (sheet_import, manual, overture, ...). */
async function importSource(db: Db): Promise<SourceHealth> {
  const id = 'imports'
  const label = 'Imports'
  return safe(async () => {
    const IMPORT_KINDS = ['sheet_import', 'csv_import', 'manual']
    const { rows } = await db.query<{ last_at: Date | null; kind: string; n24: number }>(
      `select max(max(observed_at)) over () as last_at, kind, count(*) filter (where observed_at > now() - interval '24 hours')::int as n24
         from lp.sources where kind = any($1::text[]) group by kind`,
      [IMPORT_KINDS],
    )
    if (!rows.length) return { id, label, ...EMPTY }
    const by_type_24h: Record<string, number> = {}
    let count_24h = 0
    for (const r of rows) {
      if (r.n24 > 0) by_type_24h[r.kind] = r.n24
      count_24h += r.n24
    }
    return { id, label, last_event_at: iso(rows[0]?.last_at), count_24h, by_type_24h, error_count_24h: null, last_error: null, last_error_at: null }
  }, { id, label, ...EMPTY })
}

/** lp.exports: the CSV / Google Sheet "lead master copy" export. */
async function exportSource(db: Db): Promise<SourceHealth> {
  const id = 'exports'
  const label = 'Exports (CSV / Sheets)'
  return safe(async () => {
    const { rows } = await db.query<{ last_at: Date | null; target: string; n24: number; err24: number }>(
      `select max(max(coalesce(finished_at, started_at))) over () as last_at, target,
              count(*) filter (where started_at > now() - interval '24 hours')::int as n24,
              count(*) filter (where started_at > now() - interval '24 hours' and status = 'failed')::int as err24
         from lp.exports group by target`,
    )
    if (!rows.length) return { id, label, ...EMPTY }
    const by_type_24h: Record<string, number> = {}
    let count_24h = 0
    let error_count_24h = 0
    for (const r of rows) {
      if (r.n24 > 0) by_type_24h[r.target] = r.n24
      count_24h += r.n24
      error_count_24h += r.err24
    }
    const err = await db.query<{ error: string | null; started_at: Date }>(
      `select error, started_at from lp.exports where status = 'failed' order by started_at desc limit 1`,
    )
    return {
      id,
      label,
      last_event_at: iso(rows[0]?.last_at),
      count_24h,
      by_type_24h,
      error_count_24h,
      last_error: err.rows[0]?.error ?? null,
      last_error_at: iso(err.rows[0]?.started_at),
    }
  }, { id, label, ...EMPTY })
}

/** Search Console (lib/seo/searchconsole.ts) reads live on every page load; nothing is persisted, so this is honestly "No data yet" rather than a guessed sync time. */
function searchConsoleSource(): SourceHealth {
  return { id: 'search_console', label: 'Search Console', ...EMPTY }
}

/** The background runner's own heartbeat (same signals as the Jobs page: lib/jobs/runner-status.ts). */
async function runnerHeartbeatSource(db: Db): Promise<SourceHealth> {
  const id = 'runner_heartbeat'
  const label = 'Background runner'
  return safe(async () => {
    const { loadRunnerSignals, runnerStatus } = await import('@/lib/jobs/runner-status')
    const signals = await loadRunnerSignals(db)
    const status = runnerStatus(signals)
    return {
      id,
      label,
      last_event_at: status.lastSeen,
      count_24h: null,
      by_type_24h: null,
      error_count_24h: status.state === 'offline' ? 1 : status.state === 'never' ? null : 0,
      last_error: status.state === 'offline' ? `Runner offline — last seen ${status.lastSeen ?? 'never'}` : null,
      last_error_at: status.state === 'offline' ? status.lastSeen : null,
    }
  }, { id, label, ...EMPTY })
}

/** lp.integrations: the tools hub rows (Warmbly, Listmonk, ...) already carry their own health. */
async function integrationSources(db: Db): Promise<SourceHealth[]> {
  return safe(async () => {
    const { rows } = await db.query<{
      id: string
      name: string
      health_status: string | null
      health_detail: string | null
      health_checked_at: Date | null
    }>(`select id, name, health_status, health_detail, health_checked_at from lp.integrations where active order by sort`)
    return rows
      .filter((r) => r.health_checked_at || r.health_status)
      .map((r) => ({
        id: `integration:${r.id}`,
        label: r.name,
        last_event_at: iso(r.health_checked_at),
        count_24h: null,
        by_type_24h: null,
        error_count_24h: r.health_status === 'down' ? 1 : r.health_status ? 0 : null,
        last_error: r.health_status === 'down' || r.health_status === 'degraded' ? r.health_detail : null,
        last_error_at: r.health_status === 'down' || r.health_status === 'degraded' ? iso(r.health_checked_at) : null,
      }))
  }, [])
}

/** Every source row for the Data sources panel (1.11), in display order. */
export async function sourcesHealth(db: Db): Promise<SourceHealth[]> {
  const [webhook, reconcile, verifiers, engine, imports, exports_, integrations, runner] = await Promise.all([
    leadEventSource(db, 'instantly_webhook', 'Instantly (webhook)', 'instantly_webhook'),
    jobRunSource(db, 'instantly_api', 'Instantly (nightly reconcile)', 'instantly_reconcile'),
    verifierSource(db),
    engineSource(db),
    importSource(db),
    exportSource(db),
    integrationSources(db),
    runnerHeartbeatSource(db),
  ])
  return [webhook, reconcile, verifiers, engine, imports, exports_, searchConsoleSource(), runner, ...integrations]
}
