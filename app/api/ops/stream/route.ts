/**
 * Live event stream for agents (Server-Sent Events): GET /api/ops/stream with the agent's key.
 * Each event is `event: notification` + `id: <delivery_id>` + JSON (same shape as the feed).
 * Ack with POST /api/ops/feed/ack {ids:[...]}. The connection closes after ~50 s (serverless
 * time limit) with `retry: 1000`, so EventSource / the relay reconnects at once.
 * Note: an always-connected stream keeps a function and the database awake around the clock;
 * for a 24/7 agent prefer an ntfy or webhook channel (a ping only when something happens).
 */
import { NextRequest } from 'next/server'
import { opsGate } from '@/lib/ops/gate'
import { dispatchDue, feed } from '@/lib/notify/deliver'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const WINDOW_MS = 50_000
const POLL_MS = 2_000

export async function GET(req: NextRequest) {
  const gate = await opsGate(req)
  if (!gate.ok) return gate.response
  const { agent, db } = gate
  if (!db) return new Response('database not connected', { status: 503 })
  const enc = new TextEncoder()
  const started = Date.now()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => controller.enqueue(enc.encode(s))
      send(`retry: 1000\n: hello ${agent}\n\n`)
      let lastId: number | null = null
      let lastBeat = Date.now()
      let lastDispatch = 0
      try {
        while (Date.now() - started < WINDOW_MS && !req.signal.aborted) {
          const items = await feed(db, agent, { after_id: lastId, limit: 50 })
          for (const ev of items) {
            send(`event: notification\nid: ${ev.delivery_id}\ndata: ${JSON.stringify(ev)}\n\n`)
            lastId = Math.max(lastId ?? 0, ev.delivery_id)
          }
          if (Date.now() - lastDispatch > 10_000) {
            lastDispatch = Date.now()
            await dispatchDue(db).catch(() => undefined)
          }
          if (Date.now() - lastBeat > 15_000) {
            send(': keepalive\n\n')
            lastBeat = Date.now()
          }
          await new Promise((r) => setTimeout(r, POLL_MS))
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
