/**
 * Send a Lead Master CSV to the deployed app's import endpoint in chunks, so the
 * database fills without anyone handling DATABASE_URL. Needs only an agent token.
 *
 *   OPS_URL=https://<your-app>.vercel.app OPS_TOKEN=<token from OPS_AGENT_TOKENS> \
 *     npm run push:lead-master -- --csv lead_master.csv [--dry-run] [--chunk 1000] [--start 0]
 *
 * Each chunk is a gzip-compressed JSON body of up to --chunk rows (default 1000).
 * Re-running is safe: rows already in the database are matched, never duplicated.
 * If a chunk fails after retries it stops and prints the --start to resume from.
 */
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { csvObjects } from '../lib/leads/csv.ts'

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}

type Stats = Record<string, number>

async function main() {
  const file = arg('--csv')
  const base = (process.env.OPS_URL ?? '').replace(/\/+$/, '')
  const token = (process.env.OPS_TOKEN ?? '').trim()
  if (!file) throw new Error('Give --csv <file>.')
  if (!/^https?:\/\//.test(base)) throw new Error('Set OPS_URL to the app, e.g. https://marketing-dashboard.vercel.app')
  if (!token) throw new Error('Set OPS_TOKEN to an agent token from OPS_AGENT_TOKENS.')
  const dryRun = process.argv.includes('--dry-run')
  const chunk = Math.max(1, Math.min(5000, Number(arg('--chunk') ?? 1000)))
  const start = Math.max(0, Number(arg('--start') ?? 0))

  const rows = csvObjects(readFileSync(file, 'utf8'))
  if (!rows.length || !('email' in rows[0])) throw new Error('No rows, or no "email" column in the header.')
  console.log(`parsed ${rows.length} rows from ${file}; sending ${dryRun ? '(dry run) ' : ''}in chunks of ${chunk} from row ${start}`)

  const endpoint = `${base}/api/ops/import/lead-master${dryRun ? '?dry_run=1' : ''}`
  const total: Stats = {}
  const t0 = Date.now()
  for (let i = start; i < rows.length; i += chunk) {
    const part = rows.slice(i, i + chunk)
    const body = new Uint8Array(gzipSync(new TextEncoder().encode(JSON.stringify({ rows: part }))))
    const label = `rows ${i + 1}-${i + part.length}`
    let answer: { ok?: boolean; error?: string; stats?: Stats } | null = null
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(`${endpoint}${dryRun ? '&' : '?'}label=${encodeURIComponent(label)}`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/gzip' },
          body,
          signal: AbortSignal.timeout(310_000),
        })
        const text = await res.text()
        try {
          answer = JSON.parse(text)
        } catch {
          answer = { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` }
        }
        if (res.ok && answer?.ok) break
        if (res.status === 401 || res.status === 400 || res.status === 413 || res.status === 503) break
      } catch (e) {
        answer = { ok: false, error: (e as Error).message }
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 5000))
    }
    if (!answer?.ok || !answer.stats) {
      console.error(`${label} failed: ${answer?.error ?? 'no answer'}`)
      console.error(`resume with: --start ${i}`)
      process.exit(1)
    }
    for (const [k, v] of Object.entries(answer.stats)) if (typeof v === 'number') total[k] = (total[k] ?? 0) + v
    console.log(`${label}: +${answer.stats.contacts_created} contacts, +${answer.stats.companies_created} companies, ${answer.stats.contacts_existing} already there`)
  }
  console.log(JSON.stringify({ dry_run: dryRun, ...total, seconds: Math.round((Date.now() - t0) / 1000) }, null, 2))
}

main().catch((e) => {
  console.error(`push failed: ${(e as Error).message}`)
  process.exit(1)
})
