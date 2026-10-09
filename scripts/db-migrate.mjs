#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql in filename order to DATABASE_URL, once each.
 * Applied files are recorded in lp_schema_migrations (public schema, plain table).
 *
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs            # apply pending
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs --status   # list only
 *   node scripts/db-migrate.mjs --on-build                             # what `npm run vercel-build` runs
 *
 * --on-build never fails a build for a missing database: with no DATABASE_URL it
 * prints why it skipped and exits 0. Preview builds skip too (see migrationPlan).
 * A migration that fails with a database present does fail the build, so a deploy
 * never goes live against a half-made schema (Vercel keeps the last good deploy).
 *
 * Plain Postgres: works against Neon, Supabase, the OVH server, or a laptop.
 */
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import { applyMigrations, migrationPlan, sslFor } from './lib/migrate.mjs'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
const onBuild = process.argv.includes('--on-build')
const statusOnly = process.argv.includes('--status')
const plan = migrationPlan(process.env, { onBuild })

if (!plan.run || !plan.url) {
  if (onBuild) {
    console.log(`db:migrate skipped: ${plan.reason}`)
    process.exit(0)
  }
  console.error(plan.reason)
  process.exit(2)
}

const client = new pg.Client({ connectionString: plan.url, ssl: sslFor(plan.url), connectionTimeoutMillis: 20_000 })
try {
  await client.connect()
} catch (e) {
  console.error(`db:migrate could not reach the database: ${e.message}`)
  process.exit(1)
}
try {
  if (onBuild) console.log(`db:migrate (${plan.reason})`)
  const r = await applyMigrations(client, { dir, statusOnly, log: (line) => console.log(line) })
  if (r.failed) process.exitCode = 1
  else if (!statusOnly) console.log(`db:migrate done: ${r.applied.length} applied now, ${r.already.length} already applied`)
} finally {
  await client.end()
}
