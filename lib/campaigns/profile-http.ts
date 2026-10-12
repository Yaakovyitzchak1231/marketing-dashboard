/**
 * GET  /api/campaigns/:id/profile  -> the approved profile (profileFor)
 * PATCH /api/campaigns/:id/profile {industry?, ...} -> update scalars
 *
 * Behind the login gate. Viewers may GET; a write needs editor (middleware
 * blocks viewer mutations, and the route calls actorFor('editor') so the
 * audit log names who really wrote).
 */
import { NextResponse } from 'next/server'
import type { Db } from '../db/types.ts'
import { ProfileError, upsertProfile } from '../campaign-profiles/store.ts'
import { profileFor } from './profile.ts'

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })

function posInt(v: unknown): number | null {
  const s = String(v ?? '')
  return /^\d{1,15}$/.test(s) && Number(s) > 0 ? Number(s) : null
}

export async function handleCampaignProfile(req: Request, db: Db, actor: string, campaignIdRaw: string): Promise<NextResponse> {
  const campaignId = posInt(campaignIdRaw)
  if (!campaignId) return json({ ok: false, error: 'No campaign with that id.' }, 404)
  const method = req.method.toUpperCase()
  try {
    if (method === 'GET') return json({ ok: true, ...(await profileFor(db, campaignId)) })
    if (method === 'PATCH') {
      const body = await req.json().catch(() => null)
      await upsertProfile(db, actor, campaignId, body as never)
      return json({ ok: true, ...(await profileFor(db, campaignId)) })
    }
    return json({ ok: false, error: `No route for ${method}. Use GET or PATCH.` }, 404)
  } catch (e) {
    if (e instanceof ProfileError) return json({ ok: false, error: e.message }, e.status)
    throw e
  }
}
