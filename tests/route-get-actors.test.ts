import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import { createTestDb } from './helpers/pglite-db'

/**
 * GET handlers that used to run as the literal actor 'owner': the CSV export
 * (it writes an lp.exports row), the live stream (it counts one person's
 * unread notifications) and the campaign profile read. Each now checks the
 * role first and uses the signed-in person's own actor id.
 */
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown, role: null as string | null, actor: 'owner' } }))
vi.mock('server-only', () => ({}))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db, dbConfigured: () => Boolean(holder.db) }))
vi.mock('@/lib/auth/session', () => ({
  currentRole: async () => holder.role,
  currentActorId: async () => holder.actor,
  currentEmail: async () => null,
}))
vi.mock('@/lib/notify/deliver', () => ({ dispatchDue: async () => undefined }))

import { GET as csvGet } from '@/app/api/reports/lead-master/route'
import { GET as liveGet } from '@/app/api/live/route'
import { GET as profileGet } from '@/app/api/campaigns/[id]/profile/route'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const as = (role: string | null, actor = 'owner') => {
  holder.role = role
  holder.actor = actor
}

describe('GET handlers use the signed-in actor', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
    await db.tx(
      (q) =>
        q.query(`
          insert into lp.actors (id, kind, display_name, email, role, active) values
            ('ed', 'human', 'Ed Itor', 'ed@example.com', 'editor', true),
            ('val', 'human', 'Val Viewer', 'val@example.com', 'viewer', true)`),
      'owner',
    )
  })
  afterAll(async () => {
    holder.db = null
    await db.close()
  })
  beforeEach(async () => {
    await db.query('delete from lp.exports')
  })

  describe('/api/reports/lead-master', () => {
    const exportRows = async () => (await db.query<{ created_by: string; status: string }>('select created_by, status from lp.exports')).rows

    it.each([[null], ['viewer']])('%s gets 403 and no export row is written', async (role) => {
      as(role, 'val')
      const r = await csvGet()
      expect(r.status).toBe(403)
      expect((await r.json()).ok).toBe(false)
      expect(await exportRows()).toEqual([])
    })

    it('an editor downloads the CSV and the export row names the editor, not "owner"', async () => {
      as('editor', 'ed')
      const r = await csvGet()
      expect(r.status).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/csv')
      expect(await exportRows()).toEqual([{ created_by: 'ed', status: 'done' }])
    })

    it('a signed-in owner is recorded under their own id', async () => {
      as('owner', 'owner')
      expect((await csvGet()).status).toBe(200)
      expect((await exportRows())[0].created_by).toBe('owner')
    })
  })

  describe('/api/live', () => {
    it('refuses a signed-out caller with 403 and no stream', async () => {
      as(null)
      const r = await liveGet(new Request('http://localhost/api/live'))
      expect(r.status).toBe(403)
      expect(r.headers.get('content-type')).not.toContain('text/event-stream')
    })

    it("counts the signed-in person's own unread notifications, not the owner's", async () => {
      await db.query(`delete from lp.notifications`)
      const ins = (recipient: string, n: number) =>
        db.query(
          `insert into lp.notifications (recipient, kind, summary) select $1, 'mention', 'x' from generate_series(1, $2::int)`,
          [recipient, n],
        )
      await ins('owner', 5)
      await ins('val', 2)
      as('viewer', 'val')
      const ac = new AbortController()
      const r = await liveGet(new Request('http://localhost/api/live', { signal: ac.signal }))
      expect(r.status).toBe(200)
      const reader = (r.body as ReadableStream<Uint8Array>).getReader()
      const dec = new TextDecoder()
      let text = ''
      while (!text.includes('event: change')) {
        const { value, done } = await reader.read()
        if (done) break
        text += dec.decode(value)
      }
      ac.abort()
      await reader.cancel()
      const data = /event: change\ndata: (.*)\n/.exec(text)
      expect(data).not.toBeNull()
      expect(JSON.parse((data as RegExpExecArray)[1]).unread).toBe(2)
    })
  })

  describe('/api/campaigns/:id/profile GET', () => {
    const call = () => profileGet(new Request('http://localhost/api/campaigns/1/profile'), { params: Promise.resolve({ id: '1' }) })

    it('a signed-out caller gets 403', async () => {
      as(null)
      const r = await call()
      expect(r.status).toBe(403)
      expect((await r.json()).error).toBe('Not signed in.')
    })

    it('any signed-in role gets past the gate (404 for a campaign that does not exist, never 403)', async () => {
      for (const role of ['viewer', 'editor', 'owner']) {
        as(role, 'val')
        expect((await call()).status).not.toBe(403)
      }
    })
  })
})
