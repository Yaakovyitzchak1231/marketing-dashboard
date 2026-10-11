import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import { applyChange, listChanges, undoChange } from '@/lib/seo/changes'
import { addSite } from '@/lib/seo/store'
import { SNIPPET_KEYS, WpClient, type WpFetch } from '@/lib/seo/wordpress'
import type { Db } from '@/lib/db/types'

let db: Awaited<ReturnType<typeof createTestDb>>
let siteId: number
beforeEach(async () => {
  db = await createTestDb()
  siteId = (await addSite(db, 'owner', { name: 'Journal test', base_url: 'https://journal.example' })).id
})
afterEach(async () => { await db.close() })
const cfg = { siteUrl: 'https://journal.example', user: 'test', appPassword: 'not-a-real-credential' }
const input = { kind: 'set_meta' as const, field: 'title' as const, path: '/page/', value: 'New title', expect_before: null }
function world() {
  const page = { id: 9, type: 'page', slug: 'page', link: 'https://journal.example/page/', status: 'publish', title: { raw: 'Page' }, content: { raw: '' }, meta: Object.fromEntries(SNIPPET_KEYS.map((k) => [k, ''])) }
  const pages = new Map([[page.id, page]])
  let nextId = 100
  let writes = 0
  const fetcher: WpFetch = async (url, init) => {
    const method = init?.method ?? 'GET'
    const u = new URL(url)
    const body = init?.body ? JSON.parse(init.body) : {}
    const pathname = u.pathname.replace(/\/wp-json/, '')
    if (method !== 'GET') writes++
    // Creating a draft must echo title, slug, and content. Read-back compares those fields.
    if (method === 'POST' && /\/wp\/v2\/pages$/.test(pathname)) {
      const id = nextId++
      const created = {
        id, type: 'page', slug: body.slug, link: `https://journal.example/?page_id=${id}`, status: body.status ?? 'draft',
        title: { raw: body.title ?? '' }, content: { raw: body.content ?? '' }, meta: { ...page.meta },
      }
      pages.set(id, created)
      return { status: 201, text: async () => JSON.stringify(created) }
    }
    const idMatch = pathname.match(/\/wp\/v2\/(?:pages|posts)\/(\d+)/)
    const target = (idMatch ? pages.get(Number(idMatch[1])) : null) ?? page
    if (method !== 'GET') {
      if (body.meta) Object.assign(target.meta, body.meta)
      if (body.status) target.status = body.status
      if (body.title) target.title = { raw: body.title }
      if (body.slug) target.slug = body.slug
      if (body.content !== undefined) target.content = { raw: body.content }
      if (method === 'DELETE') target.status = 'trash'
    }
    if (u.searchParams.has('slug')) {
      const slug = u.searchParams.get('slug')
      return { status: 200, text: async () => JSON.stringify([...pages.values()].filter((p) => p.slug === slug)) }
    }
    return { status: 200, text: async () => JSON.stringify(target) }
  }
  return { page, fetcher, writes: () => writes }
}

describe('WordPress durable mutation intents', () => {
  it('commits the before/after intent before sending a write', async () => {
    const w = world()
    const fetcher: WpFetch = async (url, init) => {
      if (init?.method === 'POST') {
        const [row] = await listChanges(db, { siteId })
        expect(row.status).toBe('applying')
        expect(row.applied_at).toBeNull()
        expect(row.before).toMatchObject({ meta: { _yoast_wpseo_title: '' } })
        expect(row.after).toMatchObject({ meta: { _yoast_wpseo_title: 'New title' } })
      }
      return w.fetcher(url, init)
    }
    const result = await applyChange(db, 'owner', siteId, null, input, { cfg, fetcher })
    expect(result.status).toBe('applied')
    expect(result.applied_at).not.toBeNull()
  })
  it('sends no write when saving the intent fails', async () => {
    const w = world()
    const failing: Db = { query: db.query, tx: async () => { throw new Error('journal unavailable') } }
    await expect(applyChange(failing, 'owner', siteId, null, input, { cfg, fetcher: w.fetcher })).rejects.toThrow(/journal unavailable/)
    expect(w.writes()).toBe(0)
  })
  it('a lost response preserves the intent, marks unknown and blocks replay', async () => {
    const w = world()
    const fetcher: WpFetch = async (url, init) => {
      const r = await w.fetcher(url, init)
      if (init?.method === 'POST') throw new Error('response lost after write')
      return r
    }
    await expect(applyChange(db, 'owner', siteId, null, input, { cfg, fetcher })).rejects.toThrow(/unknown outcome/)
    const [row] = await listChanges(db, { siteId })
    expect(row.status).toBe('unknown')
    expect(row.before).toMatchObject({ meta: { _yoast_wpseo_title: '' } })
    await expect(applyChange(db, 'owner', siteId, null, { ...input, expect_before: 'New title', value: 'Another' }, { cfg, fetcher: w.fetcher })).rejects.toThrow(/needs verification/)
    expect(w.writes()).toBe(1)
  })
  it('a DB failure after WordPress succeeds cannot erase the committed intent', async () => {
    const w = world()
    let transactions = 0
    const failing: Db = { query: db.query, tx: (fn, actor) => {
      if (++transactions === 2) return Promise.reject(new Error('database disconnected'))
      return db.tx(fn, actor)
    } }
    await expect(applyChange(failing, 'owner', siteId, null, input, { cfg, fetcher: w.fetcher })).rejects.toThrow(/unknown outcome/)
    expect((await listChanges(db, { siteId }))[0].status).toBe('unknown')
    expect(w.page.meta._yoast_wpseo_title).toBe('New title')
  })
  it('blocks a competing write while a committed intent is in flight', async () => {
    const w = world()
    const fetcher: WpFetch = async (url, init) => {
      if (init?.method === 'POST') await expect(applyChange(db, 'owner', siteId, null, input, { cfg, fetcher: w.fetcher })).rejects.toThrow(/needs verification/)
      return w.fetcher(url, init)
    }
    await applyChange(db, 'owner', siteId, null, input, { cfg, fetcher })
    expect(w.writes()).toBe(1)
  })
  it('never targets a sole slug result whose full path differs', async () => {
    const w = world()
    expect(await new WpClient(cfg, w.fetcher).findByPath('/wrong-parent/page/')).toBeNull()
    await expect(applyChange(db, 'owner', siteId, null, { ...input, path: '/wrong-parent/page/' }, { cfg, fetcher: w.fetcher })).rejects.toThrow(/No WordPress page/)
    expect(w.writes()).toBe(0)
  })
  it('does not create a duplicate draft when a successful request is repeated', async () => {
    const w = world()
    const draft = { kind: 'create_draft' as const, title: 'Draft', slug: 'new-draft', content: 'Content' }
    const first = await applyChange(db, 'owner', siteId, null, draft, { cfg, fetcher: w.fetcher })
    const again = await applyChange(db, 'owner', siteId, null, draft, { cfg, fetcher: w.fetcher })
    expect(again.id).toBe(first.id)
    expect(w.writes()).toBe(1)
  })
  it('reserves undo before writing and retains uncertainty after a lost response', async () => {
    const w = world()
    const applied = await applyChange(db, 'owner', siteId, null, input, { cfg, fetcher: w.fetcher })
    const fetcher: WpFetch = async (url, init) => {
      if (init?.method === 'POST') expect((await listChanges(db, { siteId }))[0].status).toBe('undoing')
      const r = await w.fetcher(url, init)
      if (init?.method === 'POST') throw new Error('lost undo response')
      return r
    }
    await expect(undoChange(db, 'owner', applied.id, { cfg, fetcher })).rejects.toThrow(/unknown outcome/)
    expect((await listChanges(db, { siteId }))[0].status).toBe('undo_unknown')
    await expect(undoChange(db, 'owner', applied.id, { cfg, fetcher: w.fetcher })).rejects.toThrow(/undo_unknown/)
  })
  it('rejects agent-side WordPress mutations without any write', async () => {
    const w = world()
    await expect(applyChange(db, 'tab', siteId, null, input, { cfg, fetcher: w.fetcher })).rejects.toThrow(/Only a person/)
    expect(w.writes()).toBe(0)
  })
})
