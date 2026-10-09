/**
 * The migration runner behind `npm run db:migrate` and the Vercel build.
 * Plain ESM with no TypeScript so it runs on any Node the build image has.
 */
import { readdirSync, readFileSync } from 'node:fs'

/** Any number works; it only has to be the same in every process that migrates. */
export const MIGRATION_LOCK_KEY = 7310402026

/**
 * Should this process migrate, and against which URL? Never returns a secret in `reason`.
 *
 * Manual runs (`npm run db:migrate`): migrate whenever a URL is set.
 * Build runs (`--on-build`, used by `npm run vercel-build`):
 *  - no DATABASE_URL: skip, the build still passes (CI and previews without a database);
 *  - Vercel preview/development builds: skip unless MIGRATE_ON_PREVIEW=1, because previews
 *    usually share the production database and a PR's migration must not reach it before merge;
 *  - production builds (and builds outside Vercel): migrate.
 * MIGRATE_ON_BUILD=0 turns the build step off entirely.
 * A direct (unpooled) URL is preferred when the integration provides one.
 *
 * @param {Record<string, string | undefined>} env
 * @param {{ onBuild?: boolean }} [opts]
 * @returns {{ run: boolean, reason: string, url: string | null }}
 */
export function migrationPlan(env, opts = {}) {
  const url = (env.DATABASE_URL_UNPOOLED || env.DATABASE_URL || '').trim() || null
  if (!url) return { run: false, reason: 'DATABASE_URL is not set, so there is no database to migrate.', url: null }
  if (!opts.onBuild) return { run: true, reason: 'manual run', url }
  if (env.MIGRATE_ON_BUILD === '0') return { run: false, reason: 'MIGRATE_ON_BUILD=0 turns the build-time migration off.', url: null }
  const vercelEnv = (env.VERCEL_ENV || '').trim()
  if (vercelEnv && vercelEnv !== 'production' && env.MIGRATE_ON_PREVIEW !== '1') {
    return {
      run: false,
      reason: `This is a ${vercelEnv} build; migrations run on production builds only (set MIGRATE_ON_PREVIEW=1 to run them here too).`,
      url: null,
    }
  }
  return { run: true, reason: vercelEnv ? `${vercelEnv} build` : 'build', url }
}

/** SSL settings for a Postgres URL (Neon, Supabase and other hosted Postgres need TLS). */
export function sslFor(url) {
  if (/sslmode=disable/.test(url)) return undefined
  if (/sslmode=require|sslmode=verify|supabase\.co|pooler\.supabase|neon\.tech/.test(url)) return { rejectUnauthorized: false }
  return undefined
}

/** db/migrations/*.sql in filename order. */
export function migrationFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
}

/**
 * Apply each pending migration once, in filename order, each in its own transaction.
 * Safe to run again and safe when two builds run at once: every file takes a
 * transaction-scoped advisory lock and re-checks lp_schema_migrations under it,
 * which also works through a transaction-mode connection pooler.
 *
 * @param {{ query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }} client
 * @param {{ dir: string, statusOnly?: boolean, log?: (line: string) => void, read?: (file: string) => string }} opts
 * @returns {Promise<{ applied: string[], already: string[], pending: string[], failed: { file: string, error: string } | null }>}
 */
export async function applyMigrations(client, opts) {
  const log = opts.log ?? (() => {})
  const read = opts.read ?? ((f) => readFileSync(`${opts.dir}/${f}`, 'utf8'))
  const out = { applied: [], already: [], pending: [], failed: null }
  await client.query(`create table if not exists lp_schema_migrations (
    filename text primary key, applied_at timestamptz not null default now())`)
  const done = async () => new Set((await client.query('select filename from lp_schema_migrations')).rows.map((r) => r.filename))
  const seen = await done()
  for (const f of migrationFiles(opts.dir)) {
    if (seen.has(f)) {
      out.already.push(f)
      log(`applied  ${f}`)
      continue
    }
    if (opts.statusOnly) {
      out.pending.push(f)
      log(`pending  ${f}`)
      continue
    }
    await client.query('begin')
    try {
      await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY])
      const again = await client.query('select 1 from lp_schema_migrations where filename = $1', [f])
      if (again.rows.length) {
        await client.query('commit')
        out.already.push(f)
        log(`applied  ${f}  (by another process)`)
        continue
      }
      await client.query(read(f))
      await client.query('insert into lp_schema_migrations (filename) values ($1)', [f])
      await client.query('commit')
      out.applied.push(f)
      log(`applied  ${f}  (now)`)
    } catch (e) {
      await client.query('rollback').catch(() => undefined)
      out.failed = { file: f, error: e instanceof Error ? e.message : String(e) }
      log(`FAILED   ${f}: ${out.failed.error}`)
      break
    }
  }
  return out
}
