#!/usr/bin/env node
/**
 * Apply db/migrations/*.sql in filename order to DATABASE_URL, once each.
 * Applied files are recorded in lp_schema_migrations (public schema, plain table).
 *
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs           # apply pending
 *   DATABASE_URL=postgres://... node scripts/db-migrate.mjs --status  # list only
 *
 * Plain Postgres: works against Supabase, the OVH server, or a laptop.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations')
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL is not set.')
  process.exit(2)
}
const statusOnly = process.argv.includes('--status')
const client = new pg.Client({ connectionString: url, ssl: /sslmode=require|supabase\.co|pooler\.supabase/.test(url) ? { rejectUnauthorized: false } : undefined })
await client.connect()
try {
  await client.query(`create table if not exists lp_schema_migrations (
    filename text primary key, applied_at timestamptz not null default now())`)
  const done = new Set((await client.query('select filename from lp_schema_migrations')).rows.map((r) => r.filename))
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()
  for (const f of files) {
    if (done.has(f)) {
      console.log(`applied  ${f}`)
      continue
    }
    if (statusOnly) {
      console.log(`pending  ${f}`)
      continue
    }
    const sql = readFileSync(join(dir, f), 'utf8')
    await client.query('begin')
    try {
      await client.query(sql)
      await client.query('insert into lp_schema_migrations (filename) values ($1)', [f])
      await client.query('commit')
      console.log(`applied  ${f}  (now)`)
    } catch (e) {
      await client.query('rollback')
      console.error(`FAILED   ${f}: ${e.message}`)
      process.exitCode = 1
      break
    }
  }
} finally {
  await client.end()
}
