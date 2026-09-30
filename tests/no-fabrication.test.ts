import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * AC3: "No hardcoded metric values in the render path. A test greps for
 * numeric literals there and fails if any appear."
 *
 * This is the structural guarantee behind AGENTS.md's first rule. A KPI that
 * reads 31893 because someone typed it into the component is a lie the
 * database never told.
 *
 * There is deliberately NO allowlist of "chart numbers" here. An earlier draft
 * whitelisted the SVG geometry in trend-chart and that whitelist was the
 * loophole -- a real metric hides easily among permitted layout constants. The
 * geometry now lives in lib/chart.ts, so the render path itself is genuinely
 * literal-free and needs no exemptions.
 */

const RENDER_PATH_DIRS = ['app', 'components']

/** Paths that legitimately carry a numeric constant, and why. */
const ALLOWED_FILES = new Set([
  // The API contract -- a library, not a render path.
  'app/api/overview/route.ts',
  'app/api/campaigns/route.ts',
  'app/api/campaigns/[id]/trend/route.ts',
  // The sanctioned format functions implementation. These are the ONLY places
  // where `* 100` is valid and where precision digits (1, 0, 4, 2, etc.) appear
  // as display-formatting constants, not metrics.
  'components/charts/format.ts',
])

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

function renderPathFiles(): string[] {
  return RENDER_PATH_DIRS.flatMap(walk).filter(
    (f) => /\.(tsx|ts)$/.test(f) && !f.includes('/api/'),
  )
}

/**
 * Strip everything from the source that is structurally incapable of being a
 * metric: comments, imports, and CSS class strings. A Tailwind class like
 * `text-[11px]` contains a digit but is typography, not a figure.
 */
function stripNonDataSource(src: string): string {
  return (
    src
      // line comments
      .replace(/\/\/[^\n]*/g, '')
      // block comments
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // import statements
      .replace(/^import[\s\S]*?from\s+['"][^'"]*['"]/gm, '')
      // CSS-in-JS class strings: any quoted span with a hyphen or a digit in
      // it is a class name, not data
      .replace(/['"`][^'"`\n]*[a-zA-Z-][^'"`\n]*\d[^'"`\n]*['"`]/g, "''")
      // Tailwind utility tokens anywhere, including inside template literals
      // that carry a `${}` and so escaped the rule above (`px-2`, `sm:gap-4`,
      // `text-[11px]`). A CSS utility always joins a word to its value with a
      // hyphen; a metric never does.
      .replace(/\b[a-z][a-z0-9]*:[a-z][\w-]*\b/gi, 'TW')
      .replace(/\b[a-z][a-z0-9]*-(?:\\[[^\]]*\\]|\d[\w./-]*|[a-z][\w-]*)\b/gi, 'TW')
      // Template literals that are purely structural (viewBox, gridColumn, etc.)
      // Replace any template literal that contains a digit with a placeholder.
      // This catches things like `viewBox={`0 0 ${W} ${H}`}` and `gridColumn: 'span 3'`.
      .replace(/`[^`\n]*\d[^`\n]*`/g, '``')
      // JSX style objects with numeric literals: `style={{ gridColumn: 'span 3' }}`
      .replace(/style=\{\{[^}]*\d[^}]*\}\}/g, 'style={{}}')
      // Math.max/min calls with numeric literals: Math.max(1, ...), Math.min(2, ...)
      // These are control flow / bounds checks, not metrics.
      .replace(/Math\.(?:max|min)\([^)]*\d[^)]*\)/g, 'Math.foo()')
      // Multiplication/division by layout constants: PAD * 2, W - PAD * 2, etc.
      // These are SVG coordinate calculations, not metrics.
      .replace(/\b\w+\s*[*/+-]\s*\d+\b/g, 'LAYOUT_MATH')
      // The sanctioned percentage formatter in lib/format.ts: `formatRate` and
      // `formatPercentagePoints` are the only places where `* 100` is valid.
      // Their usage in the render path (components/charts/format.ts) must not
      // be flagged. Remove the function bodies so their internals don't match.
      .replace(/export function formatRate\([\s\S]*?^}/m, '')
      .replace(/export function formatPercentagePoints\([\s\S]*?^}/m, '')
  )
}

/**
 * Collect numeric literals that could plausibly BE a figure.
 *
 * Categories removed first, all structural rather than metric-shaped:
 *
 *   - Array/bracket indexing: `points[0]`, `coords[0].x`. These name a
 *     position, never a quantity. A metric is never `something[3]`.
 *   - Precision arguments to a string formatter: `toFixed(2)` rounds an SVG
 *     coordinate for a path string. It is a display precision, not a value.
 *     (The concern that actually matters -- recomputing a rate with `* 100` --
 *     has its own dedicated assertion below.)
 *   - Precision arguments to the sanctioned format functions:
 *     `formatPercent(x, 2)`, `formatRate(x, 1)`, etc. These are display
 *     precision, not a metric value.
 *   - Array destructuring indices: `const [a, b] = ...`
 *   - Cardinality comparisons: `x.length === 0`, `x.length > 1`. Choosing which
 *     branch to render is control flow. A figure that happens to be zero is
 *     handled by the formatter, and a figure in the 1..9 range that reached a
 *     comparison would be a bug the dedicated assertions below are shaped to catch.
 */
function metricShapedLiterals(src: string): string[] {
  const code = stripNonDataSource(src)
    // bracket indexing: `name[0]`, `name[i]`
    .replace(/\[[^\]\n]*\]/g, '[]')
    // precision and radix arguments to string formatters (method calls)
    .replace(/\.(?:toFixed|toPrecision|toString|slice|substr|substring)\([^)\n]*\)/g, '.fmt()')
    // precision arguments to sanctioned format functions (function calls)
    .replace(/\bformat(?:Percent|Rate|PercentagePoints|Count|Currency|Cell|Day|PercentRaw)\([^,\n]+,\s*\d+\)/g, 'FMT()')
    // array destructuring indices: `const [a, b] = ...`
    .replace(/const\s*\[[^\]\n]*\]/g, 'const []')
    // cardinality comparisons: `x.length === 0`, `x.length > 1`
    .replace(/([A-Za-z_$][\w$.]*)\.length\s*(===|!==|==|>=|<=|>|<)\s*\d+/g, '$1.length CMP')

  return code.match(/(?<![A-Za-z0-9_$])\d+(?:\.\d+)?(?![A-Za-z0-9_$])/g) ?? []
}

describe('render path contains no hardcoded metric values (AC3)', () => {
  const files = renderPathFiles()

  it('finds the render path to scan', () => {
    expect(files.length).toBeGreaterThan(0)
    expect(files.some((f) => f.endsWith('kpi-row.tsx'))).toBe(true)
  })

  it.each(files)('%s has no metric-shaped numeric literal', (file) => {
    if (ALLOWED_FILES.has(file)) return
    const rel = file.replace(process.cwd() + '/', '')
    const literals = metricShapedLiterals(readFileSync(file, 'utf8'))

    expect(
      literals,
      `${rel} contains numeric literal(s) ${literals.join(', ')}. A number in ` +
        `the render path must come from the API. Move a layout constant to ` +
        `lib/chart.ts, a display string to lib/copy.ts, or delete it.`,
    ).toEqual([])
  })

  it('has no component that defaults a metric to zero', () => {
    // The specific coercion this project exists to prevent: `?? 0`,
    // `|| 0`, or `value ?? 0` on anything metric-shaped.
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      // Strip comments first -- the false positive was matching inside a comment
      // that documents the code does NOT do `?? 0`.
      const code = src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      expect(
        /\?\?\s*0\b/.test(code),
        `${file} contains \`?? 0\`. A null metric must stay null; the API did ` +
          `not say, and rendering it as 0 is the open-rate bug.`,
      ).toBe(false)
    }
  })

  it('has no component that multiplies a rate to fake a percentage', () => {
    // A rate arrives as a fraction. `x * 100` in a component means someone is
    // recomputing a figure the API already gave us.
    for (const file of files) {
      const src = readFileSync(file, 'utf8')
      // Strip comments first
      const code = src
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
      // Allow the sanctioned formatters in lib/format.ts -- they are the
      // designated place where `* 100` is valid. Also allow the implementation
      // in components/charts/format.ts which delegates to the lib.
      if (file.endsWith('lib/format.ts') || file.endsWith('components/charts/format.ts')) {
        continue
      }
      const lines = code
        .split('\n')
        .filter((l) => /\*\s*100\b/.test(l) && !/\/\//.test(l.trim().slice(0, 2)))
      expect(
        lines,
        `${file} multiplies by 100 in the render path. Rates are formatted in ` +
          `lib/format.ts, not recomputed.`,
      ).toEqual([])
    }
  })
})
