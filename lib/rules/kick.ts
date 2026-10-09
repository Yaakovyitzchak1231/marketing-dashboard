import 'server-only'
import { after } from 'next/server'
import type { Db } from '@/lib/db/types'
import { runRecompute } from './recompute'

/**
 * Run a recompute pass after the response is sent (Vercel keeps the function
 * alive for it). Never throws into the page; a failure is logged and the next
 * pass picks up where this one stopped.
 */
export function kickRecompute(db: Db, budgetMs = 20_000): void {
  const run = () =>
    runRecompute(db, { budgetMs }).catch((e) => {
      console.error('rules recompute failed', (e as Error).message)
    })
  try {
    after(run)
  } catch {
    // Outside a request (scripts, tests): run it detached.
    void run()
  }
}
