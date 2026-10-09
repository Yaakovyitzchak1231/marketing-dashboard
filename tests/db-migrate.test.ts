import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, readdirSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { applyMigrations, migrationFiles, migrationPlan, sslFor } from '@/scripts/lib/migrate.mjs'

const REAL = join(__dirname, '..', 'db', 'migrations')

/** node-postgres-shaped client over PGlite: parameterless SQL may hold several statements. */
function client(pg: PGlite) {
  return {
    async query(text: string, params?: unknown[]) {
      if (params && params.length) return pg.query(text, params)
      const all = await pg.exec(text)
      return all[all.length - 1] ?? { rows: [] }
    },
  }
}

describe('migrationPlan (when the build migrates)', () => {
  it('skips cleanly with no database, so CI and previews without one still build', () => {
    const p = migrationPlan({}, { onBuild: true })
    expect(p.run).toBe(false)
    expect(p.reason).toMatch(/DATABASE_URL is not set/)
  })
  it('runs on Vercel production builds and prefers the unpooled URL', () => {
    const p = migrationPlan({ VERCEL_ENV: 'production', DATABASE_URL: 'postgres://pooled', DATABASE_URL_UNPOOLED: 'postgres://direct' }, { onBuild: true })
    expect(p).toMatchObject({ run: true, url: 'postgres://direct' })
  })
  it('does not touch the shared database from a preview build unless asked', () => {
    expect(migrationPlan({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://x' }, { onBuild: true }).run).toBe(false)
    expect(migrationPlan({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://x', MIGRATE_ON_PREVIEW: '1' }, { onBuild: true }).run).toBe(true)
  })
  it('can be switched off, and manual runs always migrate when a URL is set', () => {
    expect(migrationPlan({ VERCEL_ENV: 'production', DATABASE_URL: 'postgres://x', MIGRATE_ON_BUILD: '0' }, { onBuild: true }).run).toBe(false)
    expect(migrationPlan({ VERCEL_ENV: 'preview', DATABASE_URL: 'postgres://x' }).run).toBe(true)
  })
  it('never puts the URL in the reason it prints', () => {
    const secret = 'postgres://user:hunter2@db.example/neondb'
    for (const env of [{ VERCEL_ENV: 'production' }, { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'production', MIGRATE_ON_BUILD: '0' }]) {
      expect(migrationPlan({ ...env, DATABASE_URL: secret }, { onBuild: true }).reason).not.toContain('hunter2')
    }
  })
  it('uses TLS for Neon and other sslmode=require URLs', () => {
    expect(sslFor('postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require')).toEqual({ rejectUnauthorized: false })
    expect(sslFor('postgres://localhost/db')).toBeUndefined()
  })
})

describe('applyMigrations', () => {
  it('applies every migration in filename order (0001 .. 0005), then nothing on a re-run', async () => {
    const files = migrationFiles(REAL)
    expect(files[0]).toBe('0001_lead_platform.sql')
    expect(files).toEqual([...files].sort())
    expect(files).toContain('0004_seo.sql')
    const pg = new PGlite()
    const first = await applyMigrations(client(pg), { dir: REAL })
    expect(first.failed).toBeNull()
    expect(first.applied).toEqual(files)
    const recorded = await pg.query<{ filename: string }>('select filename from lp_schema_migrations order by applied_at, filename')
    expect(recorded.rows.map((r) => r.filename)).toEqual(files)
    const again = await applyMigrations(client(pg), { dir: REAL })
    expect(again.applied).toEqual([])
    expect(again.already).toEqual(files)
    const t = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_schema = 'lp' and table_name = 'contacts'")
    expect(t.rows[0].n).toBe(1)
    await pg.close()
  })

  it('stops at a broken migration, rolls it back, and picks up from there next time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    writeFileSync(join(dir, '0001_a.sql'), 'create table a (id int);')
    writeFileSync(join(dir, '0002_b.sql'), 'create table b (id int); select * from nope;')
    writeFileSync(join(dir, '0003_c.sql'), 'create table c (id int);')
    const pg = new PGlite()
    const r = await applyMigrations(client(pg), { dir })
    expect(r.applied).toEqual(['0001_a.sql'])
    expect(r.failed?.file).toBe('0002_b.sql')
    const b = await pg.query<{ n: number }>("select count(*)::int as n from information_schema.tables where table_name in ('b', 'c')")
    expect(b.rows[0].n).toBe(0)
    writeFileSync(join(dir, '0002_b.sql'), 'create table b (id int);')
    const r2 = await applyMigrations(client(pg), { dir })
    expect(r2.applied).toEqual(['0002_b.sql', '0003_c.sql'])
    await pg.close()
  })

  it('--status lists pending files without applying them', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mig-'))
    for (const f of readdirSync(REAL).slice(0, 1)) copyFileSync(join(REAL, f), join(dir, f))
    const pg = new PGlite()
    const r = await applyMigrations(client(pg), { dir, statusOnly: true })
    expect(r.pending).toEqual(['0001_lead_platform.sql'])
    expect(r.applied).toEqual([])
    await pg.close()
  })
})
