import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createConnection } from 'node:net'

/**
 * Audit columns on the three agent-edited tables.
 *
 * Supabase is not assumed reachable. When it is not, this test applies the
 * committed migrations to an in-memory schema catalog (the local schema mock)
 * and queries that catalog. It does not invent row counts.
 */

const ROOT = join(__dirname, '..')
const MIGRATIONS = join(ROOT, 'supabase/migrations')

const AUDIT_COLUMNS = [
  'revision_id',
  'revision_number',
  'change_kind',
  'change_message',
  'actor',
] as const

const EDITABLE = ['ideas', 'costs', 'angles'] as const

const NOT_EDITABLE = [
  'channels',
  'leads',
  'domains',
  'inboxes',
  'campaigns',
  'daily_metrics',
  'accounts',
  'verification_runs',
  'angle_daily_metrics',
] as const

type ColumnRow = {
  table_name: string
  column_name: string
  data_type: string
}

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '')
}

function matchParen(sql: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < sql.length; i++) {
    const ch = sql[i]
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function parseCreateTables(sql: string, into: ColumnRow[]) {
  const re = /CREATE TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+(?:public\.)?([a-z_][a-z0-9_]*)\s*\(/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(sql))) {
    const table = match[1].toLowerCase()
    const open = match.index + match[0].length - 1
    const close = matchParen(sql, open)
    if (close < 0) continue
    const body = sql.slice(open + 1, close)
    for (const rawLine of body.split(',')) {
      const line = rawLine.trim()
      const col = /^([a-z_][a-z0-9_]*)\s+([a-z][a-z0-9_]*)/i.exec(line)
      if (!col) continue
      const name = col[1].toLowerCase()
      if (['constraint', 'primary', 'unique', 'check', 'foreign'].includes(name)) continue
      into.push({
        table_name: table,
        column_name: name,
        data_type: col[2].toLowerCase(),
      })
    }
    re.lastIndex = close + 1
  }
}

function parseAddColumns(sql: string, into: ColumnRow[]) {
  const re =
    /ALTER TABLE\s+(?:public\.)?([a-z_][a-z0-9_]*)\s+ADD COLUMN\s+IF\s+NOT\s+EXISTS\s+([a-z_][a-z0-9_]*)\s+([a-z][a-z0-9_]*)/gi
  let match: RegExpExecArray | null
  while ((match = re.exec(sql))) {
    const table = match[1].toLowerCase()
    const column = match[2].toLowerCase()
    if (into.some(row => row.table_name === table && row.column_name === column)) continue
    into.push({
      table_name: table,
      column_name: column,
      data_type: match[3].toLowerCase(),
    })
  }
}

/** Local schema mock: replay committed migrations, then query the catalog. */
function loadSchemaMock(): ColumnRow[] {
  const files = readdirSync(MIGRATIONS)
    .filter(name => name.endsWith('.sql'))
    .sort()
  const rows: ColumnRow[] = []
  for (const file of files) {
    const sql = stripComments(readFileSync(join(MIGRATIONS, file), 'utf8'))
    parseCreateTables(sql, rows)
    parseAddColumns(sql, rows)
  }
  return rows
}

function queryColumns(schema: ColumnRow[], table: string): ColumnRow[] {
  return schema.filter(row => row.table_name === table)
}

function probePort(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const done = (ok: boolean) => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(400)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

describe('revision audit columns', () => {
  it('queries the schema mock when Supabase is unreachable', async (ctx) => {
    const live = await probePort(54321)
    const postgres = await probePort(5432)
    // A database is listening (e.g. a developer's local Postgres) but this test
    // has no credentials to query it. Skip rather than fabricate a result; CI has
    // no database, so it always runs the schema-mock path there.
    if (live || postgres) {
      ctx.skip()
      return
    }

    const schema = loadSchemaMock()
    expect(schema.length).toBeGreaterThan(0)

    for (const table of EDITABLE) {
      const found = queryColumns(schema, table).map(row => row.column_name)
      for (const column of AUDIT_COLUMNS) {
        expect(found, `${table}.${column} missing from migration schema`).toContain(column)
      }
    }

    const revisionCols = queryColumns(schema, 'revisions').map(row => row.column_name)
    for (const column of [
      'id',
      'artifact_type',
      'artifact_id',
      'revision_number',
      'actor',
      'change_kind',
      'change_message',
      'created_at',
    ]) {
      expect(revisionCols, `revisions.${column} missing`).toContain(column)
    }
  })

  it('adds the audit columns idempotently and only on ideas, costs, angles', () => {
    const files = readdirSync(MIGRATIONS)
      .filter(name => name.endsWith('.sql'))
      .sort()
    const sql = files
      .map(name => readFileSync(join(MIGRATIONS, name), 'utf8'))
      .join('\n')

    for (const table of EDITABLE) {
      for (const column of AUDIT_COLUMNS) {
        const alter = new RegExp(
          `ALTER TABLE\\s+(?:public\\.)?${table}\\s+ADD COLUMN\\s+IF\\s+NOT\\s+EXISTS\\s+${column}\\s+`,
          'i',
        )
        expect(sql, `${table}.${column} must be ADD COLUMN IF NOT EXISTS`).toMatch(alter)
      }
    }

    const schema = loadSchemaMock()
    for (const table of NOT_EDITABLE) {
      const found = queryColumns(schema, table).map(row => row.column_name)
      for (const column of AUDIT_COLUMNS) {
        expect(found, `${table} must not gain ${column}`).not.toContain(column)
      }
    }
  })

  it('records the sequence choice in 002: 001 creates tables, 002 audits the three objects', () => {
    const header = readFileSync(join(MIGRATIONS, '002_unified_model.sql'), 'utf8').slice(0, 1200)
    expect(header).toMatch(/001 creates tables/i)
    expect(header).toMatch(/002 audits the three editable objects/i)
  })

  it('backfill assigns revision_number starting at 1 ordered by created_at', () => {
    const sql = readFileSync(join(ROOT, 'scripts/backfill_revisions.sql'), 'utf8')
    expect(sql).toMatch(/revision_number\s*=\s*1/)
    for (const table of EDITABLE) {
      expect(sql).toMatch(new RegExp(`UPDATE\\s+${table}\\b`, 'i'))
      expect(sql).toMatch(new RegExp(`FROM\\s+${table}\\b[\\s\\S]*ORDER BY\\s+[^\\n]*created_at`, 'i'))
    }
    // Provenance the source did not record stays NULL. Do not invent an actor.
    expect(sql).not.toMatch(/yaakovytroutai@gmail\.com/)
    expect(sql).not.toMatch(/SET\s+actor\s*=/i)
  })
})
