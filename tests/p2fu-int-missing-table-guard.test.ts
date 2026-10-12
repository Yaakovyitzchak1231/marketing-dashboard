import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

// Instinct #86 finding 2, follow-up (Yaakov, Oct 11): every "has this table migrated yet?"
// fallback uses lib/db/errors.ts isUndefinedTable (SQLSTATE 42P01 only). Matching the
// message /does not exist/ also swallowed missing columns, functions and schemas.
const ROOTS = ['app', 'lib', 'components']

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.(ts|tsx|mjs|js)$/.test(name)) out.push(p)
  }
  return out
}

describe('missing-table fallbacks use the SQLSTATE helper', () => {
  it('no app/lib/components code matches the "does not exist" message to detect a missing table', () => {
    const offenders: string[] = []
    for (const root of ROOTS) {
      for (const f of files(join(process.cwd(), root))) {
        const src = readFileSync(f, 'utf8')
        src.split('\n').forEach((line, i) => {
          if (/\/does not exist\/i?\.test\(/.test(line)) offenders.push(`${f.replace(process.cwd() + '/', '')}:${i + 1}`)
        })
      }
    }
    expect(offenders).toEqual([])
  })
})
