/**
 * AC1 evidence: render the shell at 390px and 1440px and prove the layout
 * does not break, then screenshot both.
 *
 * A green build is not proof. This script asserts on the live DOM:
 *   - no horizontal overflow at either width
 *   - the KPI row is present and every cell has a real width (a collapsed or
 *     clipped row still "exists" in the DOM)
 *   - no metric is rendered as 0.0% when the source did not report it
 *
 * Run: node scripts/verify-layout.mjs <baseUrl> <outDir>
 */
import { chromium } from 'playwright'
import { mkdirSync } from 'node:fs'

const baseUrl = process.argv[2] ?? 'http://127.0.0.1:3111'
const outDir = process.argv[3] ?? '/tmp/shots'
mkdirSync(outDir, { recursive: true })

const WIDTHS = [
  { name: 'mobile-390', width: 390, height: 900 },
  { name: 'desktop-1440', width: 1440, height: 1000 },
]

const browser = await chromium.launch()
let failures = 0

for (const vp of WIDTHS) {
  const page = await browser.newPage({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 2,
  })
  const errors = []
  page.on('pageerror', (e) => errors.push(String(e)))
  await page.goto(baseUrl, { waitUntil: 'networkidle' })

  const report = await page.evaluate(() => {
    const doc = document.documentElement
    // Any element wider than the viewport is a layout break, even if the
    // document itself does not scroll.
    const overflowing = [...document.querySelectorAll('*')]
      .filter((el) => el.getBoundingClientRect().right > doc.clientWidth + 1)
      .map((el) => `${el.tagName}.${el.className}`.slice(0, 80))

    const kpiRow = document.querySelector('[data-testid="kpi-row"]')
    const cells = [...document.querySelectorAll('[data-testid^="kpi-"]')].map((el) => ({
      id: el.getAttribute('data-testid'),
      w: Math.round(el.getBoundingClientRect().width),
      unavailable: el.getAttribute('data-unavailable'),
    }))

    // The honesty assertion, read from the rendered DOM: an unreported metric
    // must not be showing a percentage.
    const leaked = [...document.querySelectorAll('[data-unavailable="true"]')].filter(
      (el) => /\d/.test(el.textContent ?? ''),
    ).map((el) => el.getAttribute('data-testid') ?? el.className)

    return {
      scrollW: doc.scrollWidth,
      clientW: doc.clientWidth,
      overflowing,
      kpiRowW: kpiRow ? Math.round(kpiRow.getBoundingClientRect().width) : null,
      cells,
      leaked,
      testIds: [...document.querySelectorAll('[data-testid]')].map((e) =>
        e.getAttribute('data-testid'),
      ),
    }
  })

  await page.screenshot({ path: `${outDir}/${vp.name}.png`, fullPage: true })

  const problems = []
  if (report.scrollW > report.clientW + 1) {
    problems.push(`horizontal scroll: ${report.scrollW} > ${report.clientW}`)
  }
  if (report.overflowing.length) {
    problems.push(`overflowing elements: ${report.overflowing.join(' | ')}`)
  }
  if (report.kpiRowW === null) {
    problems.push('KPI row missing from the DOM')
  }
  const zeroWidth = report.cells.filter((c) => c.w < 40)
  if (zeroWidth.length) {
    problems.push(`collapsed KPI cells: ${zeroWidth.map((c) => `${c.id}@${c.w}px`).join(', ')}`)
  }
  if (report.leaked.length) {
    problems.push(`unreported metric showing a number: ${report.leaked.join(', ')}`)
  }
  if (errors.length) {
    problems.push(`page errors: ${errors.join('; ')}`)
  }

  console.log(`\n=== ${vp.name} (${vp.width}px) ===`)
  console.log(`scrollWidth=${report.scrollW} clientWidth=${report.clientW}`)
  console.log(`kpiRowWidth=${report.kpiRowW}`)
  console.log(`kpiCells=${report.cells.map((c) => `${c.id}:${c.w}px${c.unavailable === 'true' ? '(unavail)' : ''}`).join(' ')}`)
  console.log(`testIds(${report.testIds.length})=${report.testIds.join(',')}`)
  if (problems.length) {
    failures += problems.length
    console.log(`FAIL:\n  - ${problems.join('\n  - ')}`)
  } else {
    console.log('OK: no overflow, KPI row intact, no unreported metric showing a number')
  }

  await page.close()
}

await browser.close()
console.log(failures === 0 ? '\nALL VIEWPORTS OK' : `\n${failures} PROBLEM(S)`)
process.exit(failures === 0 ? 0 : 1)
