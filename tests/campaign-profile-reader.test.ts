import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
vi.mock('server-only', () => ({}))
import { createTestDb } from './helpers/pglite-db'
import { createCampaign } from '@/lib/campaigns/store'
import { activeProfiles, profileFor } from '@/lib/campaigns/profile'
import { handleCampaignProfile } from '@/lib/campaigns/profile-http'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'
import { ProfileError } from '@/lib/campaign-profiles/store'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

describe('campaign profile reader, REST, validate/export/import (plan 1.16)', () => {
  let db: TestDb
  let campaignId: number

  beforeAll(async () => {
    db = await createTestDb()
    campaignId = (await createCampaign(db, 'owner', { name: 'Profile reader' } as never)).id
  })
  afterAll(async () => {
    await db.close()
  })

  it('profileFor reads an empty draft and creates nothing; 404 if the campaign is missing', async () => {
    const before = await db.query<{ n: number }>('select count(*)::int as n from lp.campaign_profiles')
    const view = await profileFor(db, campaignId)
    expect(view.exists).toBe(false)
    expect(view.campaign_name).toBe('Profile reader')
    expect(view.profile.setup_status).toBe('draft')
    expect(view.items.competitor).toEqual([])
    const after = await db.query<{ n: number }>('select count(*)::int as n from lp.campaign_profiles')
    expect(after.rows[0].n).toBe(before.rows[0].n)
    await expect(profileFor(db, 999999)).rejects.toBeInstanceOf(ProfileError)
  })

  it('profileFor returns approved items only', async () => {
    await runOp(db, 'claude', 'add_profile_items', {
      campaign_id: campaignId,
      items: [
        { kind: 'competitor', name: 'Toast', value: 'toasttab.com', status: 'approved' },
        { kind: 'keyword', name: 'brunch', status: 'suggested' },
      ],
    })
    const view = await profileFor(db, campaignId)
    expect(view.items.competitor.map((i) => i.name)).toEqual(['Toast'])
    expect(view.items.keyword).toEqual([])
  })

  it('activeProfiles is setup_status active and not archived', async () => {
    await runOp(db, 'claude', 'update_campaign_profile', { campaign_id: campaignId, industry: 'Restaurants', setup_status: 'active' })
    const listed = await activeProfiles(db)
    expect(listed.map((p) => p.campaign_id)).toContain(campaignId)

    const paused = (await createCampaign(db, 'owner', { name: 'Paused but active profile', status: 'paused' } as never)).id
    await runOp(db, 'claude', 'update_campaign_profile', { campaign_id: paused, industry: 'Dental', setup_status: 'active' })
    expect((await activeProfiles(db)).map((p) => p.campaign_id)).toContain(paused)

    const archived = (await createCampaign(db, 'owner', { name: 'Archived profile', status: 'archived' } as never)).id
    await runOp(db, 'claude', 'update_campaign_profile', { campaign_id: archived, industry: 'Gone', setup_status: 'active' })
    expect((await activeProfiles(db)).map((p) => p.campaign_id)).not.toContain(archived)

    const draft = (await createCampaign(db, 'owner', { name: 'Draft profile' } as never)).id
    await runOp(db, 'claude', 'update_campaign_profile', { campaign_id: draft, industry: 'Still drafting', setup_status: 'draft' })
    expect((await activeProfiles(db)).map((p) => p.campaign_id)).not.toContain(draft)
  })

  it('validate refuses a bad feed and an unknown key, and writes nothing', async () => {
    const before = await db.query<{ n: number }>('select count(*)::int as n from lp.campaign_profile_items')
    await expect(runOp(db, 'claude', 'validate_campaign_profile', { items: [{ kind: 'feed', name: 'bad', value: 'not-a-url' }] })).rejects.toBeInstanceOf(OpsError)
    await expect(runOp(db, 'claude', 'validate_campaign_profile', { bogus: 1 })).rejects.toBeInstanceOf(OpsError)
    const ok = (await runOp(db, 'claude', 'validate_campaign_profile', {
      profile: { industry: 'Dental' },
      items: [{ kind: 'competitor', name: 'Dentrix', source: 'ai' }],
    })) as { ok: boolean; items: { source: string }[] }
    expect(ok.ok).toBe(true)
    expect(ok.items[0].source).toBe('import')
    const after = await db.query<{ n: number }>('select count(*)::int as n from lp.campaign_profile_items')
    expect(after.rows[0].n).toBe(before.rows[0].n)
  })

  it('export then import merges, skips duplicates, and stamps source import', async () => {
    const exported = (await runOp(db, 'claude', 'export_campaign_profile', { campaign_id: campaignId })) as {
      exists: boolean
      profile: { industry: string }
      items: { name: string; kind: string }[]
    }
    expect(exported.exists).toBe(true)
    expect(exported.profile.industry).toBe('Restaurants')
    expect(exported.items.some((i) => i.kind === 'competitor' && i.name === 'Toast')).toBe(true)

    const dest = (await createCampaign(db, 'owner', { name: 'Import dest' } as never)).id
    const imported = (await runOp(db, 'claude', 'import_campaign_profile', {
      campaign_id: dest,
      profile: exported.profile,
      items: exported.items,
    })) as { added: { source: string; name: string }[]; already: unknown[]; profile: { industry: string } }
    expect(imported.profile.industry).toBe('Restaurants')
    expect(imported.added.length).toBeGreaterThan(0)
    expect(imported.added.every((i) => i.source === 'import')).toBe(true)

    const again = (await runOp(db, 'claude', 'import_campaign_profile', {
      campaign_id: dest,
      items: [{ kind: 'competitor', name: 'Toast', value: 'toasttab.com' }],
    })) as { added: unknown[]; already: { name: string }[] }
    expect(again.added).toEqual([])
    expect(again.already.map((i) => i.name)).toEqual(['Toast'])
    await expect(runOp(db, 'claude', 'export_campaign_profile', { campaign_id: 999999 })).rejects.toMatchObject({ status: 404 })
  })

  it('GET /api/campaigns/:id/profile returns the approved view; PATCH updates scalars', async () => {
    const got = await handleCampaignProfile(new Request('http://localhost/api/campaigns/1/profile'), db, 'owner', String(campaignId))
    expect(got.status).toBe(200)
    const body = (await got.json()) as { ok: boolean; items: { competitor: { name: string }[]; keyword: unknown[] } }
    expect(body.ok).toBe(true)
    expect(body.items.competitor.map((i) => i.name)).toEqual(['Toast'])
    expect(body.items.keyword).toEqual([])

    const patched = await handleCampaignProfile(
      new Request('http://localhost/api/campaigns/1/profile', { method: 'PATCH', body: JSON.stringify({ value_prop: 'Fill tables' }) }),
      db,
      'editor-1',
      String(campaignId),
    )
    expect(patched.status).toBe(200)
    const next = (await patched.json()) as { profile: { value_prop: string; updated_by: string } }
    expect(next.profile.value_prop).toBe('Fill tables')
    expect(next.profile.updated_by).toBe('editor-1')

    const missing = await handleCampaignProfile(new Request('http://localhost'), db, 'owner', 'nope')
    expect(missing.status).toBe(404)
  })
})
