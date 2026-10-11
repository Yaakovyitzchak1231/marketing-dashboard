// Auto-registers every handler module in this directory (except this file):
// each module exports { kind, handle(ctx) }. Adding a new job kind is one new
// file here -- nothing to wire up elsewhere. Also used by the tools-hub
// pollers (changedetection / Miniflux / Listmonk / Umami snapshots): they are
// just another kind, typically backed by 'ops_call' or their own small file.
//
// ctx given to every handle(): { campaignId, payload, signal, ops(op, args), log(line) }
//   - campaignId: lp.jobs.campaign_id, or null for a workspace-wide job
//   - payload:    lp.jobs.payload (the job's own config)
//   - signal:     an AbortSignal that fires when the job's timeout_s elapses
//   - ops(op, args): calls one dashboard ops API op with the runner's key
//   - log(line):  one line, tagged with the job name and run id already
import { readdir } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

export async function loadHandlers() {
  const map = new Map()
  const files = (await readdir(HERE)).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
  for (const file of files.sort()) {
    const mod = await import(pathToFileURL(join(HERE, file)).href)
    if (!mod.kind || typeof mod.handle !== 'function') {
      throw new Error(`runner/handlers/${file} must export { kind, handle(ctx) }`)
    }
    if (map.has(mod.kind)) throw new Error(`two handlers register kind "${mod.kind}" (one is runner/handlers/${file})`)
    map.set(mod.kind, { handle: mod.handle, file })
  }
  return map
}
