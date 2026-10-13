/**
 * Warmbly ops for agents (TAP-118): the same live, read-only read the /tools
 * panel shows, so Tab/Hermes can check mailbox warm-up and campaigns without a
 * browser. Never returns the API key (only where it came from).
 */
import type { Db } from '../db/types.ts'

type Args = Record<string, unknown>
type Op = { args: string; run: (db: Db, actor: string, a: Args) => Promise<unknown> }

export const WARMBLY_OPS: Record<string, Op> = {
  warmbly_snapshot: {
    args: '{}  -> live read-only read of his Warmbly: {state: ready|no_key|no_url, base_url, key_source (db|env), snapshot: {me, mailboxes, campaigns, warmup (last 14 days), allowance}}; each part is {ok, value} or {ok:false, error}; never the key',
    run: async () => {
      // config.ts is server-only (it reaches the settings store and DB); load it on use.
      const { loadWarmblyView } = await import('./config.ts')
      const view = await loadWarmblyView()
      if (view.state === 'ready') return { state: view.state, base_url: view.baseUrl, key_source: view.keySource, snapshot: view.snapshot }
      if (view.state === 'no_key') return { state: view.state, base_url: view.baseUrl }
      return { state: view.state }
    },
  },
}
