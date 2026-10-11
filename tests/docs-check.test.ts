import { describe, expect, it } from 'vitest'
import { findProblems } from '../scripts/check-docs.mjs'

const ARCH = { path: 'docs/ARCHITECTURE.md', text: 'map: `app/`, `lib/`, `docs/`' }
const TOP = ['app', 'docs', 'lib']

function run(
  files: { path: string; text: string }[],
  existing: string[],
  scripts: string[] = ['dev', 'check'],
  arch = ARCH,
) {
  const set = new Set([...existing, 'app', 'docs', 'lib'])
  return findProblems({
    files: [arch, ...files],
    exists: (p: string) => set.has(p),
    scripts,
    topDirs: TOP,
  }) as string[]
}

describe('docs check', () => {
  it('passes when every link, script, path and directory is real', () => {
    const problems = run(
      [{ path: 'README.md', text: 'See [the map](docs/ARCHITECTURE.md), run `npm run check`, edit `lib/db/index.ts`.' }],
      ['docs/ARCHITECTURE.md', 'lib/db/index.ts', 'README.md'],
    )
    expect(problems).toEqual([])
  })

  it('flags a Markdown link to a missing file', () => {
    const problems = run([{ path: 'README.md', text: '[gone](docs/MISSING.md)' }], ['docs/ARCHITECTURE.md'])
    expect(problems).toEqual(['README.md:1: link target does not exist: docs/MISSING.md'])
  })

  it('resolves links relative to the document, and ignores URLs and anchors', () => {
    const problems = run(
      [{ path: 'docs/guide.md', text: '[up](../README.md) [web](https://example.com) [here](#top) [x](ARCHITECTURE.md#map)' }],
      ['README.md', 'docs/ARCHITECTURE.md', 'docs/guide.md'],
    )
    expect(problems).toEqual([])
  })

  it('flags an npm script that package.json does not define', () => {
    const problems = run([{ path: 'README.md', text: 'run `npm run deploy`' }], ['docs/ARCHITECTURE.md'])
    expect(problems).toEqual(['README.md:1: npm script not in package.json: deploy'])
  })

  it('does not mistake npm flags such as "npm run -s" for a script name', () => {
    const problems = run([{ path: 'README.md', text: 'npm run -s export' }], ['docs/ARCHITECTURE.md'], ['export'])
    expect(problems).toEqual([])
  })

  it('flags a backticked repo path that does not exist, but not routes or prose', () => {
    const problems = run(
      [{ path: 'README.md', text: 'edit `lib/gone.ts` and call `/api/ops`, not `a/b` or `sort`' }],
      ['docs/ARCHITECTURE.md'],
    )
    expect(problems).toEqual(['README.md:1: backticked path does not exist: lib/gone.ts'])
  })

  it('flags a top-level directory that the architecture map does not mention', () => {
    const partial = { path: 'docs/ARCHITECTURE.md', text: 'map: `lib/`, `docs/`' }
    const problems = run([], ['docs/ARCHITECTURE.md'], undefined, partial)
    expect(problems).toEqual(['docs/ARCHITECTURE.md: top-level directory not mapped: app/'])
  })

  it('fails when the architecture map is missing', () => {
    const problems = findProblems({ files: [], exists: () => true, scripts: [], topDirs: [] }) as string[]
    expect(problems).toEqual(['docs/ARCHITECTURE.md: missing (the architecture map must exist)'])
  })
})
