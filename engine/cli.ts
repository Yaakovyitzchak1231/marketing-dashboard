/**
 * The lead engine's command line. Runs with plain Node 22 (no build step):
 *
 *   npm run engine -- worker --agent tab                 # claim and work find_leads / research_company tasks, forever
 *   npm run engine -- worker --agent tab --once          # one task, then exit
 *   npm run engine -- run --segment jeweler --states MD --max 10
 *   npm run engine -- run --cities "Towson, MD" --max 10 --stages discover,crawl,build
 *   npm run engine -- run --file stores.csv --max 50     # discovery from a CSV/JSONL list instead of Maps
 *   npm run engine -- status 12                          # counters for find_leads task #12
 *
 * Env: DATABASE_URL (lead hub) or OPS_URL + OPS_TOKEN (ops API, research only);
 * optional ENGINE_PROXIES, SERPER_API_KEY or SEARXNG_URL.
 * Long jobs belong on a server (the OVH VPS), never inside a Vercel function.
 */
import { createPgDb } from '../lib/db/pg.ts'
import { claimTask, createTask } from '../lib/ops/core.ts'
import { normalizeFindParams, findJobTitle } from './params.ts'
import { recordFindJob } from './findJobRecord.ts'
import { computeCounters } from './store.ts'
import { opsApiFromEnv, runWorkerApi, runWorkerDb, workTaskDb, ENGINE_KINDS } from './worker.ts'

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = (args: string[], name: string) => args.includes(`--${name}`)

async function main() {
  const [cmd, ...args] = process.argv.slice(2)
  const agent = arg(args, 'agent') ?? 'tab'
  const url = process.env.DATABASE_URL
  let stopping = false
  process.on('SIGINT', () => {
    if (stopping) process.exit(130)
    stopping = true
    console.log('stopping after the current task (Ctrl-C again to quit now; the lease expires and the job resumes later)')
  })

  if (cmd === 'worker') {
    const kinds = (arg(args, 'kinds') ?? ENGINE_KINDS.join(',')).split(',').map((s) => s.trim()).filter(Boolean)
    const opts = { agent, kinds, once: flag(args, 'once'), pollSeconds: Number(arg(args, 'poll') ?? 30), shouldStop: () => stopping }
    if (url) {
      const db = createPgDb(url)
      const n = await runWorkerDb(db, opts)
      console.log(`worker ${agent}: ${n} task${n === 1 ? '' : 's'} worked`)
      process.exit(0)
    }
    const api = opsApiFromEnv()
    if (!api) throw new Error('set DATABASE_URL (or OPS_URL + OPS_TOKEN for research-only work over the ops API)')
    const n = await runWorkerApi(api, opts)
    console.log(`worker ${agent}: ${n} task${n === 1 ? '' : 's'} worked over the ops API`)
    process.exit(0)
  }

  if (cmd === 'run') {
    if (!url) throw new Error('run needs DATABASE_URL')
    const file = arg(args, 'file')
    const params = normalizeFindParams({
      segment: arg(args, 'segment') ?? 'jeweler',
      states: arg(args, 'states'),
      cities: arg(args, 'cities'),
      all_us: flag(args, 'all-us'),
      max_businesses: Number(arg(args, 'max') ?? 10),
      stages: arg(args, 'stages'),
      queries: arg(args, 'queries'),
      proxies: flag(args, 'proxies'),
      source: file ? 'file' : 'maps',
      file_path: file,
      concurrency: { maps: arg(args, 'maps-conc'), crawl: arg(args, 'crawl-conc') },
    })
    const db = createPgDb(url)
    const poolLabel = (await db.query<{ label: string }>('select label from lp.pools where id = $1', [params.segment])).rows[0]?.label ?? null
    if (!poolLabel) throw new Error(`No pool "${params.segment}". Create it in Settings > Pools first.`)
    const task = await createTask(db, agent, { kind: 'find_leads', title: findJobTitle(params, poolLabel), assigned_to: agent, payload: params as unknown as Record<string, unknown>, max_attempts: 5 })
    await recordFindJob(db, {
      task_id: task.id,
      campaign_id: params.campaign_id,
      pool: params.segment,
      title: task.title,
      params: params as unknown as Record<string, unknown>,
      config_source: params.config_source,
      created_by: agent,
    })
    const claimed = await claimTask(db, agent, { kinds: ['find_leads'], task_id: task.id, lease_seconds: 600 })
    if (!claimed) throw new Error(`could not claim task ${task.id}`)
    console.log(`find_leads task #${task.id}: ${task.title}`)
    const r = await workTaskDb(db, claimed, { agent, log: (l) => console.log(l) })
    console.log(JSON.stringify(await computeCounters(db, (await db.query<{ id: number }>('select id from lp.engine_runs where task_id = $1', [task.id])).rows[0]?.id ?? 0), null, 1))
    process.exit(r === 'done' ? 0 : 1)
  }

  if (cmd === 'status') {
    if (!url) throw new Error('status needs DATABASE_URL')
    const id = Number(args[0])
    const db = createPgDb(url)
    const { rows } = await db.query<{ id: number; status: string; stage: string; notes: string[] }>('select id, status, stage, notes from lp.engine_runs where task_id = $1', [id])
    if (!rows.length) throw new Error(`no engine run for task ${id}`)
    console.log(JSON.stringify({ ...rows[0], counters: await computeCounters(db, rows[0].id) }, null, 1))
    process.exit(0)
  }

  console.log('usage: engine worker --agent tab [--once] | engine run --segment jeweler --states MD --max 10 | engine status <task_id>')
  process.exit(cmd ? 2 : 0)
}

main().catch((e) => {
  console.error((e as Error).message)
  process.exit(1)
})
