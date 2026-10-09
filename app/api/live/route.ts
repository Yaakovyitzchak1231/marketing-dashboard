/**
 * Live updates for the signed-in person (the login gate in middleware.ts protects this route).
 * Server-Sent Events: `event: change` whenever anything new lands (activity, notifications,
 * delivery status), carrying {unread, last_event_id}. The page then re-reads its data.
 * Closes after ~50 s with retry: 1000 so the browser reconnects at once. While a page is open,
 * it also pushes anything due to agents (retries need no cron).
 */
import { getDb } from '@/lib/db'
import { dispatchDue } from '@/lib/notify/deliver'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const ME = 'owner'
const WINDOW_MS = 50_000
// 10 s keeps Neon's compute and the function cheap while a page is open; the browser stops
// listening after 15 idle minutes (components/ops/live.ts), so nothing stays awake all day.
const POLL_MS = 10_000

export async function GET(req: Request) {
  const db = getDb()
  if (!db) return new Response('database not connected', { status: 503 })
  const enc = new TextEncoder()
  const started = Date.now()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s))
      send('retry: 1000\n\n')
      let last = ''
      let lastBeat = Date.now()
      let lastDispatch = 0
      try {
        while (Date.now() - started < WINDOW_MS && !req.signal.aborted) {
          const { rows } = await db.query<{ ev: number | null; unread: number; n: number | null; d: string | null }>(
            `select (select max(id) from lp.events) as ev,
                    (select count(*)::int from lp.notifications where recipient = $1 and read_at is null) as unread,
                    (select max(id) from lp.notifications) as n,
                    (select max(updated_at)::text from lp.deliveries) as d`,
            [ME],
          )
          const r = rows[0]
          const sig = `${r.ev}|${r.unread}|${r.n}|${r.d}`
          if (sig !== last) {
            send(`event: change\ndata: ${JSON.stringify({ unread: r.unread, last_event_id: r.ev, first: last === '' })}\n\n`)
            last = sig
          }
          if (Date.now() - lastDispatch >= 10_000) {
            lastDispatch = Date.now()
            await dispatchDue(db).catch(() => undefined)
          }
          if (Date.now() - lastBeat > 15_000) {
            send(': keepalive\n\n')
            lastBeat = Date.now()
          }
          await new Promise((res) => setTimeout(res, POLL_MS))
        }
      } catch (e) {
        send(`event: error\ndata: ${JSON.stringify({ error: (e as Error).message })}\n\n`)
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' },
  })
}
