import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { SettingTextField } from '@/components/settings/SettingTextField'
import { SecretField } from '@/components/settings/SecretField'
import { AgentsSection } from '@/components/settings/AgentsSection'
import { NeedsSetup } from '@/components/settings/NeedsSetup'
import { MailInUse } from '@/components/settings/MailInUse'
import { QuietHoursField } from '@/components/settings/QuietHoursField'
import { QUIET_END_KEY, QUIET_START_KEY } from '@/lib/settings/quiet-hours'
import { ModelPicker } from '@/components/settings/ModelPicker'
import { listAiModelsAction } from '@/app/actions/ai-models'
import { recordEnvSecretsSeen } from '@/lib/settings/env-seen'
import { resolveTimezone } from '@/lib/dashboard/dates'
import { listActorKinds, listIntegrationSettings, listSecretStatuses, listSettings } from '@/lib/settings/store'
import { SETTING_GROUP_HELP, SETTINGS_REGISTRY, settingsByGroup } from '@/lib/settings/registry'
import { needsSetup, settingAnchor, type SetupField } from '@/lib/settings/needs-setup'
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
  // Env-backed secrets: last 4 + when first seen (only those 4 chars reach the client).
  const envSeen = await recordEnvSecretsSeen(db, SETTINGS_REGISTRY.filter((s) => s.secret && s.envFallback && !secretsByKey.get(s.key)?.set).map((s) => s.envFallback as string))
  const timeZone = resolveTimezone(settingsByKey.get('workspace.timezone')?.value ?? process.env.DASHBOARD_TZ)
  // Sending (lib/notify/mail.ts) reads MAIL_* from the server env only, so the
  // Email sending group shows what is actually in use and says so plainly.
  const mailKeySeen = (await recordEnvSecretsSeen(db, ['MAIL_API_KEY'])).get('MAIL_API_KEY')
  const mailInUse = {
    provider: process.env.MAIL_PROVIDER?.trim() || null,
    from: process.env.MAIL_FROM?.trim() || null,
    keySet: Boolean(process.env.MAIL_API_KEY?.trim()),
    keyLast4: process.env.MAIL_API_KEY?.trim() ? (mailKeySeen?.last4 ?? null) : null,
    keySeenAt: process.env.MAIL_API_KEY?.trim() ? (mailKeySeen?.firstSeenAt ?? null) : null,
  }

  // Source badge without a DB round trip per field: a saved row means 'db';
  // otherwise an env fallback with something in it means 'env'; otherwise 'unset'.
  const sourceOf = (key: string, envFallback?: string): 'db' | 'env' | 'unset' => {
    if (settingsByKey.has(key)) return 'db'
    if (envFallback && process.env[envFallback]?.trim()) return 'env'
    return 'unset'
  }

  // Every field on this page, in page order, for the "Needs setup" box at the top.
  const setupFields: SetupField[] = [
    ...groups.flatMap(({ group, items }) =>
      // Quiet hours is one control on the page, so it is one item here too:
      // listed once as "Quiet hours", set only when both ends are.
      items
        .filter((spec) => spec.key !== QUIET_END_KEY)
        .map((spec): SetupField =>
          spec.key === QUIET_START_KEY
            ? {
                key: spec.key,
                label: 'Quiet hours',
                group,
                secret: false,
                value: settingsByKey.get(QUIET_START_KEY)?.value && settingsByKey.get(QUIET_END_KEY)?.value ? 'set' : null,
                optional: spec.optional,
              }
            : {
                key: spec.key,
                label: spec.label,
                group,
                secret: spec.secret,
                envFallback: spec.envFallback,
                value: settingsByKey.get(spec.key)?.value ?? null,
                secretSet: secretsByKey.get(spec.key)?.set ?? false,
                optional: spec.optional,
              },
        ),
    ),
    ...integrations.flatMap((i) => [
      { key: i.apiKeyKey, label: `${i.name} API key`, group: 'Integrations', secret: true, secretSet: i.apiKeyStatus.set },
      { key: i.apiUrlKey, label: `${i.name} API URL`, group: 'Integrations', secret: false, value: i.apiUrlSource === 'unset' ? null : i.apiUrlValue ?? 'env' },
    ]),
  ]
  const setupItems = needsSetup(setupFields)

  return (
    <PageFrame title="Settings" meta="API keys, mail, Google sheets, and workspace defaults. Secret values never come back to this screen — only their last 4 characters and when they were set.">
      {!keyReady ? (
        <Card className="mb-6 border-warn/40 p-4">
          <p className="text-[13px] font-semibold text-warn">Secrets are read-only until SETTINGS_KEY is set</p>
          <p className="mt-1 text-[12.5px] leading-snug text-ink-muted">
            Add <code className="rounded bg-canvas px-1 font-numeric text-[12px]">SETTINGS_KEY</code> in Vercel (Settings → Environment Variables) — 32 random bytes, e.g.{' '}
            <code className="rounded bg-canvas px-1 font-numeric text-[12px]">openssl rand -base64 32</code> — then redeploy. Non-secret settings below still work now.
          </p>
        </Card>
      ) : null}

      <NeedsSetup items={setupItems} />

      {groups.map(({ group, items }) => {
        const nonSecret = items.filter((s) => !s.secret && s.key !== QUIET_START_KEY && s.key !== QUIET_END_KEY)
        const hasQuietHours = items.some((s) => s.key === QUIET_START_KEY)
        const secrets = items.filter((s) => s.secret)
        if (!items.length) return null
        return (
          <section key={group} className="mb-6">
            <SectionHeader title={group} />
            {SETTING_GROUP_HELP[group] ? <p className="-mt-1 mb-2 max-w-3xl text-[12.5px] leading-snug text-ink-muted">{SETTING_GROUP_HELP[group]}</p> : null}
            {group === 'Email sending' ? <MailInUse keySet={mailInUse.keySet} provider={mailInUse.provider} from={mailInUse.from} keyLast4={mailInUse.keyLast4} keySeenAt={mailInUse.keySeenAt} timeZone={timeZone} /> : null}
            <Card className="p-4">
              {nonSecret.map((spec) =>
                spec.key === 'ai.model' ? (
                  <div key={spec.key} id={settingAnchor(spec.key)} className="scroll-mt-20 target:bg-warn-soft">
                  <ModelPicker
                    settingKey={spec.key}
                    label={spec.label}
                    help={spec.help}
                    value={settingsByKey.get(spec.key)?.value ?? null}
                    source={sourceOf(spec.key, spec.envFallback)}
                    placeholder={spec.placeholder}
                    providerReady={sourceOf('ai.base_url', 'AI_BASE_URL') !== 'unset'}
                    action={saveSettingAction}
                    loadModels={listAiModelsAction}
                  />
                  </div>
                ) : (
                <SettingTextField
                  key={spec.key}
                  anchorId={settingAnchor(spec.key)}
                  settingKey={spec.key}
                  label={spec.label}
                  help={spec.help}
                  value={settingsByKey.get(spec.key)?.value ?? null}
                  source={sourceOf(spec.key, spec.envFallback)}
                  placeholder={spec.placeholder}
                  multiline={spec.multiline}
                  options={spec.options}
                  action={saveSettingAction}
                />
                ),
              )}
              {hasQuietHours ? (
                <QuietHoursField
                  start={settingsByKey.get(QUIET_START_KEY)?.value ?? null}
                  end={settingsByKey.get(QUIET_END_KEY)?.value ?? null}
                  anchorStart={settingAnchor(QUIET_START_KEY)}
                  anchorEnd={settingAnchor(QUIET_END_KEY)}
                  action={saveSettingAction}
                />
              ) : null}
              {secrets.map((spec) => {
                const status = secretsByKey.get(spec.key) ?? { set: false, last4: null, updated_at: null, updated_by: null }
                return (
                  <div key={spec.key} id={settingAnchor(spec.key)} className="scroll-mt-20 target:bg-warn-soft">
                  <SecretField
                    key={spec.key}
                    settingKey={spec.key}
                    label={spec.label}
                    help={spec.help}
                    status={status}
                    envConfigured={Boolean(spec.envFallback && process.env[spec.envFallback]?.trim())}
                    envLast4={spec.envFallback ? (envSeen.get(spec.envFallback)?.last4 ?? null) : null}
                    envSeenAt={spec.envFallback ? (envSeen.get(spec.envFallback)?.firstSeenAt ?? null) : null}
                    timeZone={timeZone}
                    testable={Boolean(spec.testable)}
                    settingsKeyReady={keyReady}
                    replaceAction={replaceSecretAction}
                    clearAction={clearSecretAction}
                    testAction={testSecretAction}
                  />
                  </div>
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
                <span id={settingAnchor(i.apiKeyKey)} className="block scroll-mt-20" aria-hidden />
                <SecretField
                  settingKey={i.apiKeyKey}
                  label={`${i.name} API key`}
                  status={i.apiKeyStatus}
                  envConfigured={false}
                  timeZone={timeZone}
                  testable={false}
                  settingsKeyReady={keyReady}
                  replaceAction={replaceSecretAction}
                  clearAction={clearSecretAction}
                  testAction={testSecretAction}
                />
                <SettingTextField anchorId={settingAnchor(i.apiUrlKey)} settingKey={i.apiUrlKey} label={`${i.name} API URL`} value={i.apiUrlValue} source={i.apiUrlSource} placeholder="https://..." action={saveSettingAction} />
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
