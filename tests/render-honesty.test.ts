import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Structural guards on the render path (app/ pages + components/), replacing
 * the old literal-grep test that was tied to the deleted components.
 *  - A null metric must never be coerced to 0 (`?? 0` / `|| 0`).
 *  - Rates are formatted in components/dashboard/format.ts only; `* 100`
 *    anywhere else in the render path means someone is recomputing a figure.
 */
function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const files = ['app', 'components']
  .flatMap(walk)
  .filter((f) => /\.(tsx?|mts)$/.test(f) && !f.startsWith(join('app', 'api')))

const code = (f: string) =>
  readFileSync(f, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '')

describe('render path honesty', () => {
  it('scans the dashboard components', () => {
    expect(files).toContain(join('components', 'dashboard', 'Kpis.tsx'))
  })

  it.each(files)('%s never defaults a metric to zero', (f) => {
    expect(/\?\?\s*0(?![.\d])/.test(code(f))).toBe(false)
    expect(/\|\|\s*0(?![.\d])/.test(code(f))).toBe(false)
  })

  it.each(files)('%s only multiplies by 100 inside a formatter', (f) => {
    const lines = code(f)
      .split('\n')
      .filter((l) => /\*\s*100\b/.test(l))
    if (f.endsWith(join('components', 'dashboard', 'format.ts'))) return
    // DailyChart's toPct converts a layout fraction to CSS, not a metric.
    const allowed = lines.filter((l) => !/fraction \* 100/.test(l))
    expect(allowed).toEqual([])
  })
})
