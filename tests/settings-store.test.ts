import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
vi.mock('server-only', () => ({}))
const { holder } = vi.hoisted(() => ({ holder: { db: null as unknown } }))
vi.mock('@/lib/db', () => ({ getDb: () => holder.db }))

import { createTestDb } from './helpers/pglite-db'
import {
  clearSecret,
  getSetting,
  listActorKinds,
  listIntegrationSettings,
  listSecretStatuses,
  listSettings,
  putSecret,
  putSetting,
  resolveConfig,
  secretStatus,
  setActorTakesKinds,
  SettingsError,
} from '@/lib/settings/store'
import { mailConfiguredAsync, sendMail } from '@/lib/notify/mail'

type TestDb = Awaited<ReturnType<typeof createTestDb>>
const KEY_B64 = Buffer.alloc(32, 5).toString('base64')

async function history(db: TestDb, key: string) {
  const { rows } = await db.query<{ field: string; old_value: string | null; new_value: string | null; changed_by: string; via: string }>(
    `select field, old_value, new_value, changed_by, via from lp.status_history where entity_type = 'setting' and entity_key = $1 order by id`,
    [key],
  )
  return rows
}

describe('settings store (real Postgres via PGlite)', () => {
  let db: TestDb
  beforeAll(async () => {
    db = await createTestDb()
    holder.db = db
  })
  afterAll(async () => {
    await db.close()
  })

  it('put/get a non-secret setting, validated, with a plain-text audit row', async () => {
    const row = await putSetting(db, 'owner', 'workspace.timezone', 'America/Chicago')
    expect(row.value).toBe('America/Chicago')
    expect(await getSetting(db, 'workspace.timezone')).toBe('America/Chicago')
    expect(await history(db, 'workspace.timezone')).toEqual([{ field: 'workspace.timezone', old_value: null, new_value: 'America/Chicago', changed_by: 'owner', via: 'ui' }])
  })

  it('rejects an invalid value before writing anything', async () => {
    await expect(putSetting(db, 'owner', 'workspace.timezone', 'Not/A/Zone')).rejects.toThrow(SettingsError)
    await expect(putSetting(db, 'owner', 'workspace.quiet_hours_start', '9pm')).rejects.toThrow(/HH:MM/)
  })

  it('an agent cannot write a setting; a person can', async () => {
    await expect(putSetting(db, 'tab', 'workspace.date_format', 'YYYY-MM-DD')).rejects.toThrow(/Only a person/)
    await putSetting(db, 'owner', 'workspace.date_format', 'YYYY-MM-DD')
    expect(await getSetting(db, 'workspace.date_format')).toBe('YYYY-MM-DD')
  })

  it('refuses a secret key through the non-secret path, and vice versa', async () => {
    await expect(putSetting(db, 'owner', 'instantly.api_key', 'sk-123')).rejects.toThrow(/is a secret/)
    await expect(putSecret(db, 'owner', 'workspace.timezone', 'x')).rejects.toThrow(/is not a secret/)
  })

  it('unknown key is refused with 404', async () => {
    await expect(putSetting(db, 'owner', 'not.a.real.key', 'x')).rejects.toMatchObject({ status: 404 })
  })

  it('saving the same value again writes no new audit row', async () => {
    await putSetting(db, 'owner', 'workspace.date_format', 'YYYY-MM-DD')
    const before = (await history(db, 'workspace.date_format')).length
    await putSetting(db, 'owner', 'workspace.date_format', 'YYYY-MM-DD')
    expect((await history(db, 'workspace.date_format')).length).toBe(before)
  })

  it('secrets: putSecret requires SETTINGS_KEY; without it the save is refused with a plain message', async () => {
    const old = process.env.SETTINGS_KEY
    delete process.env.SETTINGS_KEY
    try {
      await expect(putSecret(db, 'owner', 'instantly.api_key', 'sk-abcd1234')).rejects.toThrow(/SETTINGS_KEY is not set/)
    } finally {
      if (old !== undefined) process.env.SETTINGS_KEY = old
    }
  })

  it('secrets: put, status shows set/last4 only, list/status never return the value, audit row carries no secret text', async () => {
    process.env.SETTINGS_KEY = KEY_B64
    const status = await putSecret(db, 'owner', 'instantly.api_key', 'sk-abcd1234')
    expect(status).toEqual({ key: 'instantly.api_key', set: true, last4: '1234', updated_at: expect.anything(), updated_by: 'owner' })

    const s2 = await secretStatus(db, 'instantly.api_key')
    expect(s2.set).toBe(true)
    expect(s2.last4).toBe('1234')
    expect(JSON.stringify(s2)).not.toContain('sk-abcd1234')

    const all = await listSecretStatuses(db)
    const mine = all.find((r) => r.key === 'instantly.api_key')
    expect(mine?.set).toBe(true)
    expect(JSON.stringify(all)).not.toContain('sk-abcd1234')

    const rows = await history(db, 'instantly.api_key')
    expect(rows).toHaveLength(1)
    expect(rows[0].new_value).toBe('set \u20261234')
    expect(rows[0].new_value).not.toContain('sk-abcd1234')
    expect(JSON.stringify(rows)).not.toContain('sk-abcd1234')
  })

  it('replacing a secret updates last4 and writes a second audit row (old -> new, both redacted)', async () => {
    await putSecret(db, 'owner', 'instantly.api_key', 'sk-newkey-9999')
    const rows = await history(db, 'instantly.api_key')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ old_value: 'set \u20261234', new_value: 'set \u20269999' })
  })

  it('clearing a secret removes it; status reports not set; clearing again is a no-op', async () => {
    const cleared = await clearSecret(db, 'owner', 'instantly.api_key')
    expect(cleared.set).toBe(false)
    expect((await secretStatus(db, 'instantly.api_key')).set).toBe(false)
    const before = (await history(db, 'instantly.api_key')).length
    await clearSecret(db, 'owner', 'instantly.api_key')
    expect((await history(db, 'instantly.api_key')).length).toBe(before)
  })

  it('an agent cannot replace or clear a secret', async () => {
    await expect(putSecret(db, 'tab', 'instantly.api_key', 'sk-nope')).rejects.toThrow(/Only a person/)
    await putSecret(db, 'owner', 'instantly.api_key', 'sk-again-0001')
    await expect(clearSecret(db, 'tab', 'instantly.api_key')).rejects.toThrow(/Only a person/)
  })

  it('resolveConfig: db wins over env; env is the fallback when nothing is saved; unset when neither exists', async () => {
    await putSetting(db, 'owner', 'workspace.timezone', 'America/Denver')
    expect(await resolveConfig('workspace.timezone', { DASHBOARD_TZ: 'America/New_York' })).toEqual({ value: 'America/Denver', source: 'db' })

    await clearSecret(db, 'owner', 'instantly.api_key')
    expect(await resolveConfig('instantly.api_key', { INSTANTLY_API_KEY: 'env-key-123' })).toEqual({ value: 'env-key-123', source: 'env' })

    expect(await resolveConfig('mail.api_key', {})).toEqual({ value: null, source: 'unset' })
  })

  it('mail delivery uses saved settings before environment fallbacks', async () => {
    const previousSettingsKey = process.env.SETTINGS_KEY
    process.env.SETTINGS_KEY = KEY_B64
    try {
      await putSetting(db, 'owner', 'mail.provider', 'resend')
      await putSetting(db, 'owner', 'mail.from', 'DB Alerts <db-alerts@example.com>')
      await putSecret(db, 'owner', 'mail.api_key', 'db-resend-api-key')

      const env = {
        NODE_ENV: 'test' as const,
        MAIL_PROVIDER: 'brevo',
        MAIL_API_KEY: 'env-brevo-api-key',
        MAIL_FROM: 'Env Alerts <env-alerts@example.com>',
      }
      expect(await mailConfiguredAsync({})).toBe(true)

      const requests: { url: string; init?: RequestInit }[] = []
      const result = await sendMail(
        { to: 'person@example.com', subject: 'Saved config', text: 'Mail from the settings store' },
        async (url, init) => {
          requests.push({ url, init })
          return Response.json({ id: 'db-mail-1' })
        },
        env,
      )

      expect(result).toEqual({ ok: true, id: 'db-mail-1' })
      expect(requests).toHaveLength(1)
      expect(requests[0].url).toBe('https://api.resend.com/emails')
      expect(new Headers(requests[0].init?.headers).get('authorization')).toBe('Bearer db-resend-api-key')
      expect(JSON.parse(String(requests[0].init?.body))).toMatchObject({ from: 'DB Alerts <db-alerts@example.com>' })
    } finally {
      if (previousSettingsKey === undefined) delete process.env.SETTINGS_KEY
      else process.env.SETTINGS_KEY = previousSettingsKey
    }
  })

  it('listSettings / listSecretStatuses cover the full registry shape without leaking secret values', async () => {
    const settings = await listSettings(db)
    expect(settings.some((s) => s.key === 'workspace.timezone')).toBe(true)
    const secrets = await listSecretStatuses(db)
    expect(secrets.map((s) => s.key)).toContain('millionverifier.api_key')
    expect(secrets.find((s) => s.key === 'millionverifier.api_key')?.set).toBe(false)
  })

  it('dynamic integrations.*.api_key / api_url keys are accepted and never leak values', async () => {
    await db.query(
      `insert into lp.integrations (id, name, kind, settings_prefix) values ('listmonk', 'Listmonk', 'listmonk', 'integrations.listmonk') on conflict (id) do nothing`,
    )
    await putSetting(db, 'owner', 'integrations.listmonk.api_url', 'http://100.104.103.48:18510')
    await putSecret(db, 'owner', 'integrations.listmonk.api_key', 'lm-secret-key-42')

    const rows = await listIntegrationSettings(db)
    const row = rows.find((r) => r.id === 'listmonk')
    expect(row).toBeTruthy()
    expect(row?.apiUrlValue).toBe('http://100.104.103.48:18510')
    expect(row?.apiKeyStatus.set).toBe(true)
    expect(row?.apiKeyStatus.last4).toBe('y-42')
    expect(JSON.stringify(rows)).not.toContain('lm-secret-key-42')
  })

  it('agent task kinds: list, set, validation, person-only, and an audit row', async () => {
    const actors = await listActorKinds(db)
    expect(actors.find((a) => a.id === 'tab')?.takes_kinds).toEqual([])

    await expect(setActorTakesKinds(db, 'tab', 'tab', ['find_leads'])).rejects.toThrow(/Only a person/)
    await expect(setActorTakesKinds(db, 'owner', 'tab', ['Not Valid!'])).rejects.toThrow(SettingsError)

    const updated = await setActorTakesKinds(db, 'owner', 'tab', ['find_leads', 'verify_contacts', 'find_leads'])
    expect(updated.takes_kinds).toEqual(['find_leads', 'verify_contacts'])

    const { rows } = await db.query<{ field: string; old_value: string; new_value: string; entity_key: string }>(
      `select field, old_value, new_value, entity_key from lp.status_history where entity_type = 'actor' and entity_key = 'tab' order by id desc limit 1`,
    )
    expect(rows[0]).toMatchObject({ field: 'takes_kinds', old_value: '(any)', new_value: 'find_leads, verify_contacts', entity_key: 'tab' })
  })
})
