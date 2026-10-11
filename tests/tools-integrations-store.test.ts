import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb } from './helpers/pglite-db'
import {
  IntegrationError,
  addSnapshots,
  campaignIdForNewsletterList,
  campaignIdForUtmCampaign,
  getIntegration,
  latestMetrics,
  listIntegrations,
  reportHealth,
  upsertIntegration,
} from '@/lib/integrations/store'
import { runOp } from '@/lib/ops/dispatch'
import { OpsError } from '@/lib/ops/core'

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function addCampaign(db: TestDb, name: string, pool = 'other'): Promise<number> {
  const { rows } = await db.query<{ id: number }>(
    `insert into lp.campaigns (name, pool) values ($1, $2) returning id`,
    [name, pool],
  )
  return rows[0].id
}

describe('integrations store (real Postgres via PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('migration 0022: the seed rows exist, Postiz does not', async () => {
    const rows = await listIntegrations(db)
    const ids = rows.map((r) => r.id).sort()
    expect(ids).toEqual(['build_plan', 'build_tracker', 'changedetection', 'listmonk', 'miniflux', 'umami', 'warmbly'])
    expect(ids).not.toContain('postiz')
    const warmbly = rows.find((r) => r.id === 'warmbly')!
    expect(warmbly.reachable_from).toBe('public')
    expect(warmbly.url).toContain('ovh-hermes.taila95862.ts.net')
    const listmonk = rows.find((r) => r.id === 'listmonk')!
    expect(listmonk.reachable_from).toBe('tailnet')
    expect(listmonk.api_url).toContain('127.0.0.1')
    expect(listmonk.settings_prefix).toBe('integrations.listmonk')
    const sheet = rows.find((r) => r.id === 'build_tracker')!
    expect(sheet.kind).toBe('sheet')
    expect(sheet.health_status).toBeNull()
    expect(sheet.health_checked_at).toBeNull()
  })

  it('activeOnly filters inactive rows', async () => {
    await upsertIntegration(db, 'owner', 'n8n', { name: 'n8n', kind: 'n8n', active: false })
    const all = await listIntegrations(db)
    const active = await listIntegrations(db, { activeOnly: true })
    expect(all.map((r) => r.id)).toContain('n8n')
    expect(active.map((r) => r.id)).not.toContain('n8n')
  })

  it('upsertIntegration creates, then edits only what is sent', async () => {
    const created = await upsertIntegration(db, 'owner', 'zapier', { name: 'Zapier', kind: 'zapier', url: 'https://zapier.com' })
    expect(created).toMatchObject({ id: 'zapier', name: 'Zapier', kind: 'zapier', reachable_from: 'public', active: true })
    const edited = await upsertIntegration(db, 'owner', 'zapier', { name: 'Zapier (new)' })
    expect(edited.name).toBe('Zapier (new)')
    expect(edited.kind).toBe('zapier') // unchanged
    const fetched = await getIntegration(db, 'zapier')
    expect(fetched?.name).toBe('Zapier (new)')
  })

  it('validates id, kind, url and reachable_from', async () => {
    await expect(upsertIntegration(db, 'owner', 'Not A Slug', { name: 'x', kind: 'x' })).rejects.toThrow(IntegrationError)
    await expect(upsertIntegration(db, 'owner', 'badkind', { name: 'x', kind: 'Not Valid' })).rejects.toThrow(IntegrationError)
    await expect(upsertIntegration(db, 'owner', 'badurl', { name: 'x', kind: 'x', url: 'not-a-url' })).rejects.toThrow(IntegrationError)
    await expect(upsertIntegration(db, 'owner', 'badreach', { name: 'x', kind: 'x', reachable_from: 'space' as never })).rejects.toThrow(IntegrationError)
  })

  it('reportHealth updates status, detail and checked_at; rejects a bad status', async () => {
    const before = await getIntegration(db, 'listmonk')
    expect(before?.health_checked_at).toBeNull()
    const after = await reportHealth(db, 'listmonk', { status: 'ok', detail: 'HTTP 200 in 40ms' })
    expect(after.health_status).toBe('ok')
    expect(after.health_detail).toBe('HTTP 200 in 40ms')
    expect(after.health_checked_at).toBeInstanceOf(Date)
    await expect(reportHealth(db, 'listmonk', { status: 'nope' as never })).rejects.toThrow(IntegrationError)
    await expect(reportHealth(db, 'no-such-tool', { status: 'ok' })).rejects.toThrow(IntegrationError)
  })

  it('addSnapshots is null-safe (value: null is never coerced to 0) and batches in one insert', async () => {
    const campaignId = await addCampaign(db, 'Restaurants Q4')
    const { inserted } = await addSnapshots(db, 'listmonk', [
      { metric: 'listmonk.subscribers', value: 120, dims: { list: 'Restaurants Q4' }, campaign_id: campaignId },
      { metric: 'listmonk.subscribers', value: null, dims: { list: 'Unmapped list' } },
    ])
    expect(inserted).toBe(2)
    const latest = await latestMetrics(db, { integrationId: 'listmonk' })
    const mapped = latest.find((m) => m.dims.list === 'Restaurants Q4')
    const unmapped = latest.find((m) => m.dims.list === 'Unmapped list')
    expect(mapped?.value).toBe(120)
    expect(mapped?.campaign_id).toBe(campaignId)
    expect(unmapped?.value).toBeNull()
    expect(unmapped?.campaign_id).toBeNull()
  })

  it('latestMetrics returns only the newest row per (integration, metric, campaign)', async () => {
    await addSnapshots(db, 'changedetection', [{ metric: 'changedetection.changes_24h', value: 1, dims: {} }])
    await new Promise((r) => setTimeout(r, 5))
    await addSnapshots(db, 'changedetection', [{ metric: 'changedetection.changes_24h', value: 3, dims: {} }])
    const latest = await latestMetrics(db, { integrationId: 'changedetection' })
    expect(latest).toHaveLength(1)
    expect(latest[0].value).toBe(3)
  })

  it('campaign_id filter on latestMetrics only matches that campaign (not the global/null rows)', async () => {
    const campaignId = await addCampaign(db, 'Dental clinics pilot')
    await addSnapshots(db, 'umami', [
      { metric: 'umami.visits_24h', value: 10, dims: {} }, // global
      { metric: 'umami.visits_24h', value: 4, dims: { utm_campaign: 'dental' }, campaign_id: campaignId },
    ])
    const filtered = await latestMetrics(db, { integrationId: 'umami', campaignId })
    expect(filtered).toHaveLength(1)
    expect(filtered[0].value).toBe(4)
  })

  it('addSnapshots rejects a bad metric slug, too many snapshots, or an unknown integration', async () => {
    await expect(addSnapshots(db, 'listmonk', [{ metric: 'Not Valid!', value: 1 }])).rejects.toThrow(IntegrationError)
    await expect(addSnapshots(db, 'no-such-tool', [{ metric: 'x.y', value: 1 }])).rejects.toThrow(IntegrationError)
    const many = Array.from({ length: 501 }, (_, i) => ({ metric: `listmonk.x${i}`, value: i }))
    await expect(addSnapshots(db, 'listmonk', many)).rejects.toThrow(IntegrationError)
  })

  it('upsertIntegration writes one lp.status_history row per changed field, keyed by entity_key (slug), entity_id null', async () => {
    await upsertIntegration(db, 'owner', 'audited-tool', { name: 'Audited Tool', kind: 'other' }, { via: 'ui' })
    await upsertIntegration(db, 'owner', 'audited-tool', { name: 'Audited Tool 2', sort: 50 }, { via: 'ops_api' })
    const { rows } = await db.query<{ entity_id: number | null; entity_key: string; field: string; via: string }>(
      `select entity_id, entity_key, field, via from lp.status_history where entity_type = 'integration' and entity_key = 'audited-tool' order by id`,
    )
    expect(rows.every((r) => r.entity_id === null)).toBe(true)
    expect(rows.every((r) => r.entity_key === 'audited-tool')).toBe(true)
    expect(rows[0]).toMatchObject({ field: 'created', via: 'ui' })
    const fields = rows.slice(1).map((r) => r.field).sort()
    expect(fields).toEqual(['name', 'sort'])
    expect(rows.slice(1).every((r) => r.via === 'ops_api')).toBe(true)
  })

  it('campaignIdForNewsletterList / campaignIdForUtmCampaign match via lp.campaign_profiles, case-insensitively', async () => {
    const campaignId = await addCampaign(db, 'Jewelers fall pilot')
    await db.query(`insert into lp.campaign_profiles (campaign_id, newsletter_list, utm) values ($1, 'Fall Jewelers', '{"campaign":"fall-jewelers"}'::jsonb)`, [campaignId])
    expect(await campaignIdForNewsletterList(db, 'fall jewelers')).toBe(campaignId)
    expect(await campaignIdForNewsletterList(db, 'no such list')).toBeNull()
    expect(await campaignIdForUtmCampaign(db, 'Fall-Jewelers')).toBe(campaignId)
    expect(await campaignIdForUtmCampaign(db, 'nope')).toBeNull()
  })
})

describe('integrations ops (dispatch + permissions)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(async () => {
    await db.close()
  })

  it('list_integrations and latest_integration_metrics are open to any actor', async () => {
    const rows = (await runOp(db, 'tab', 'list_integrations', {})) as unknown[]
    expect(rows.length).toBeGreaterThan(0)
    const metrics = await runOp(db, 'hermes', 'latest_integration_metrics', {})
    expect(Array.isArray(metrics)).toBe(true)
  })

  it('put_integration is owner-only', async () => {
    await expect(runOp(db, 'tab', 'put_integration', { id: 'x', name: 'X', kind: 'x' })).rejects.toThrow(OpsError)
    const row = (await runOp(db, 'owner', 'put_integration', { id: 'x', name: 'X', kind: 'x' })) as { id: string }
    expect(row.id).toBe('x')
  })

  it('report_integration_health and put_integration_snapshots: system or owner only, never another agent', async () => {
    await expect(runOp(db, 'hermes', 'report_integration_health', { id: 'listmonk', status: 'ok' })).rejects.toThrow(OpsError)
    await expect(runOp(db, 'hermes', 'put_integration_snapshots', { id: 'listmonk', snapshots: [{ metric: 'listmonk.subscribers', value: 1 }] })).rejects.toThrow(OpsError)
    const healthed = (await runOp(db, 'system', 'report_integration_health', { id: 'listmonk', status: 'degraded', detail: 'slow' })) as { health_status: string }
    expect(healthed.health_status).toBe('degraded')
    const snapped = (await runOp(db, 'owner', 'put_integration_snapshots', { id: 'listmonk', snapshots: [{ metric: 'listmonk.subscribers', value: 7 }] })) as { inserted: number }
    expect(snapped.inserted).toBe(1)
  })

  it('campaign_for_newsletter_list / campaign_for_utm_campaign ops round-trip', async () => {
    const r1 = (await runOp(db, 'tab', 'campaign_for_newsletter_list', { list: 'no such list anywhere' })) as { campaign_id: number | null }
    expect(r1.campaign_id).toBeNull()
    const r2 = (await runOp(db, 'tab', 'campaign_for_utm_campaign', { utm_campaign: 'no such utm anywhere' })) as { campaign_id: number | null }
    expect(r2.campaign_id).toBeNull()
  })
})
