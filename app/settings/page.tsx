import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { SettingTextField } from '@/components/settings/SettingTextField'
import { SecretField } from '@/components/settings/SecretField'
import { AgentsSection } from '@/components/settings/AgentsSection'
import { listActorKinds, listIntegrationSettings, listSecretStatuses, listSettings } from '@/lib/settings/store'
import { settingsByGroup } from '@/lib/settings/registry'
import { settingsKeyConfigured } from '@/lib/settings/crypto'
import { clearSecretAction, replaceSecretAction, saveSettingAction, setAgentTakesKindsAction, testSecretAction } from '@/app/actions/settings'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Settings" meta="API keys, mail, Google sheets, and workspace defaults">
        <DbNotConnected what="Settings" />
      </PageFrame>
    )
  }

  const [settingsRows, secretRows, actors, integrations] = await Promise.all([listSettings(db), listSecretStatuses(db), listActorKinds(db), listIntegrationSettings(db)])
  const settingsByKey = new Map(settingsRows.map((s) => [s.key, s]))
  const secretsByKey = new Map(secretRows.map((s) => [s.key, s]))
  const groups = settingsByGroup()
  const keyReady = settingsKeyConfigured()

  // Source badge without a DB round trip per field: a saved row means 'db';
  // otherwise an env fallback with something in it means 'env'; otherwise 'unset'.
  const sourceOf = (key: string, envFallback?: string): 'db' | 'env' | 'unset' => {
    if (settingsByKey.has(key)) return 'db'
    if (envFallback && process.env[envFallback]?.trim()) return 'env'
    return 'unset'
  }

  return (
    <PageFrame title="Settings" meta="API keys, mail, Google sheets, and workspace defaults. Secret values never come back to this screen — only whether one is set.">
      {!keyReady ? (
        <Card className="mb-6 border-warn/40 p-4">
          <p className="text-[13px] font-semibold text-warn">Secrets are read-only until SETTINGS_KEY is set</p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
            Add <code className="rounded bg-canvas px-1 font-numeric text-[12px]">SETTINGS_KEY</code> in Vercel (Settings → Environment Variables) — 32 random bytes, e.g.{' '}
            <code className="rounded bg-canvas px-1 font-numeric text-[12px]">openssl rand -base64 32</code> — then redeploy. Non-secret settings below still work now.
          </p>
        </Card>
      ) : null}

      {groups.map(({ group, items }) => {
        const nonSecret = items.filter((s) => !s.secret)
        const secrets = items.filter((s) => s.secret)
        if (!items.length) return null
        return (
          <section key={group} className="mb-6">
            <SectionHeader title={group} />
            <Card className="p-4">
              {nonSecret.map((spec) => (
                <SettingTextField
                  key={spec.key}
                  settingKey={spec.key}
                  label={spec.label}
                  help={spec.help}
                  value={settingsByKey.get(spec.key)?.value ?? null}
                  source={sourceOf(spec.key, spec.envFallback)}
                  placeholder={spec.placeholder}
                  multiline={spec.multiline}
                  action={saveSettingAction}
                />
              ))}
              {secrets.map((spec) => {
                const status = secretsByKey.get(spec.key) ?? { set: false, last4: null, updated_at: null, updated_by: null }
                return (
                  <SecretField
                    key={spec.key}
                    settingKey={spec.key}
                    label={spec.label}
                    help={spec.help}
                    status={status}
                    envConfigured={Boolean(spec.envFallback && process.env[spec.envFallback]?.trim())}
                    testable={Boolean(spec.testable)}
                    settingsKeyReady={keyReady}
                    replaceAction={replaceSecretAction}
                    clearAction={clearSecretAction}
                    testAction={testSecretAction}
                  />
                )
              })}
            </Card>
          </section>
        )
      })}

      {integrations.length ? (
        <section className="mb-6">
          <SectionHeader title="Integrations" meta="Tools on the OVH box (Warmbly, Listmonk, Miniflux, ...) that read their credentials from here" />
          <Card className="p-4">
            {integrations.map((i) => (
              <div key={i.id} className="border-b border-line-soft py-1 last:border-b-0">
                <SecretField
                  settingKey={i.apiKeyKey}
                  label={`${i.name} API key`}
                  status={i.apiKeyStatus}
                  envConfigured={false}
                  testable={false}
                  settingsKeyReady={keyReady}
                  replaceAction={replaceSecretAction}
                  clearAction={clearSecretAction}
                  testAction={testSecretAction}
                />
                <SettingTextField settingKey={i.apiUrlKey} label={`${i.name} API URL`} value={i.apiUrlValue} source={i.apiUrlSource} placeholder="https://..." action={saveSettingAction} />
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <section className="mb-6">
        <SectionHeader title="Agents" meta="Which task kinds each agent picks up" />
        <Card className="p-4">
          <AgentsSection actors={actors} action={setAgentTakesKindsAction} />
        </Card>
      </section>

      <p className="text-[12px] leading-relaxed text-ink-faint">
        A key saved here is read before its environment variable, everywhere that has been wired up to the settings store (Instantly, so far). Everything else still
        reads its environment variable directly until it is wired up too.
      </p>
    </PageFrame>
  )
}
