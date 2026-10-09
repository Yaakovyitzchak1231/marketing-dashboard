import 'server-only'
import { after } from 'next/server'
import type { Db } from '@/lib/db/types'
import { dispatchDue } from './deliver'

/**
 * Send whatever is due right after the current request's response has gone out
 * (Next's after(): the person's click is not slowed by a webhook or an email).
 * Outside a request (scripts, tests) it simply runs in the background.
 */
export function kickDelivery(db: Db | null): void {
  if (!db) return
  const run = async () => {
    try {
      await dispatchDue(db)
    } catch (e) {
      console.error('delivery dispatch failed', (e as Error).message)
    }
  }
  try {
    after(run)
  } catch {
    void run()
  }
}
