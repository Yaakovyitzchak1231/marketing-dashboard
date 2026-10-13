import { getDb } from '@/lib/db'
import { DbNotConnected, PageFrame } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { SettingTextField } from '@/components/settings/SettingTextField'
import { SecretField } from '@/components/settings/SecretField'
import { AgentsSection } from '@/components/settings/AgentsSection'
import { NeedsSetup } from '@/components/settings/NeedsSetup'
import { MailInUse } from '@/components/settings/MailInUse'
import { DeliveryReadiness } from '@/components/settings/DeliveryReadiness'
import { QuietHoursField } from '@/components/settings/QuietHoursField'
import { QUIET_END_KEY, QUIET_START_KEY } from '@/lib/settings/quiet-hours'
import { ModelPicker } from '@/components/settings/ModelPicker'
import { listAiModelsAction } from '@/app/actions/ai-models'
import { recordEnvSecretsSeen } from '@/lib/settings/env-seen'
import { resolveTimezone } from '@/lib/dashboard/dates'
import { listActorKinds, listIntegrationSettings, listSecretStatuses, listSettings, resolveConfig } from '@/lib/settings/store'
import { SETTING_GROUP_HELP, SETTINGS_REGISTRY, settingsByGroup } from '@/lib/settings/registry'
import { envStatus } from '@/lib/setup/env'
import { readDeliveryHealth } from '@/lib/notify/health'
import { needsSetup, settingAnchor, type SetupField } from '@/lib/settings/needs-setup'
import { settingsKeyConfigured } from '@/lib/settings/crypto'
import { clearSecretAction, replaceSecretAction, saveQuietHoursAction, saveSettingAction, setAgentTakesKindsAction, testSecretAction } from '@/app/actions/settings'
import Link from 'next/link'
import { listRetentionPolicies } from '@/lib/retention/store'
import { RetentionPolicyRow } from '@/components/settings/RetentionPolicyRow'
import { RunSweepButton } from '@/components/settings/RunSweepButton'
import { addTeamMemberAction, changeTeamMemberRoleAction, removeTeamMemberAction } from '@/app/actions/team'
import { TeamSection } from '@/components/settings/TeamSection'
import { currentRole } from '@/lib/auth/session'
import { listTeamMembers, type TeamMemberRow } from '@/lib/team/store'
import { isUndefinedTable } from '@/lib/db/errors'


export const dynamic = 'force-dynamic'

/**
 * listTeamMembers() reads lp.actors.role, which migration 0029 adds. Previews
 * never run migrations (PHASE2_COMMON.md), so a PR #78 preview hits this page
 * against a database that still has lp.actors without that column -- without
 * this guard that throws inside the page's Promise.all and the whole Settings
 * screen crashes to the error boundary. An honest "needs migration" reads the
 * same as the empty-state convention the rest of the dashboard already uses
 * (lib/setup/db-status.ts, lib/scoring's Settings page): any other DB error
 * still surfaces as a real failure rather than being swallowed as "no team".
 */
async function listTeamMembersSafe(db: NonNullable<ReturnType<typeof getDb>>): Promise<{ members: TeamMemberRow[]; needsMigration: boolean }> {
  try {
    return { members: await listTeamMembers(db), needsMigration: false }
  } catch (e) {
    if (isUndefinedTable(e)) return { members: [], needsMigration: true }
    throw e
  }
}

export default async function SettingsPage() {
  const db = getDb()
  const notificationEnv = envStatus('notifications')
  if (!db) {
    return (
      <PageFrame title="Settings" meta="API keys, mail, Google sheets, and workspace defaults">
        <DbNotConnected what="Settings" />
        <DeliveryReadiness health={await readDeliveryHealth(null)} notificationEnv={notificationEnv} />
      </PageFrame>
    )
  }

  const [settingsRows, secretRows, actors, integrations, team, role, deliveryHealth] = await Promise.all([
    listSettings(db),
    listSecretStatuses(db),
    listActorKinds(db),
    listIntegrationSettings(db),
    listTeamMembersSafe(db),
    currentRole(),
    readDeliveryHealth(db),
  ])
  const { members: teamMembers, needsMigration: needsTeamMigration } = team
  let retentionPolicies: Awaited<ReturnType<typeof listRetentionPolicies>> = []
  let retentionNeedsMigration = false
  try {
    retentionPolicies = await listRetentionPolicies(db)
  } catch (e) {
    if (isUndefinedTable(e)) retentionNeedsMigration = true
    else throw e
  }

  const settingsByKey = new Map(settingsRows.map((s) => [s.key, s]))
  const secretsByKey = new Map(secretRows.map((s) => [s.key, s]))
  const groups = settingsByGroup()
  const keyReady = settingsKeyConfigured()
  // Env-backed secrets: last 4 + when first seen (only those 4 chars reach the client).
  const envSeen = await recordEnvSecretsSeen(db, SETTINGS_REGISTRY.filter((s) => s.secret && s.envFallback && !secretsByKey.get(s.key)?.set).map((s) => s.envFallback as string))
  const timeZone = resolveTimezone(settingsByKey.get('workspace.timezone')?.value ?? process.env.DASHBOARD_TZ)
  // Match the effective DB-first values that sendMail resolves; show only a mask for the key.
  const [mailProvider, mailKey, mailFrom] = await Promise.all([
    resolveConfig('mail.provider'),
    resolveConfig('mail.api_key'),
    resolveConfig('mail.from'),
  ])
  const mailKeySeen = (await recordEnvSecretsSeen(db, ['MAIL_API_KEY'])).get('MAIL_API_KEY')
  const mailKeyStatus = secretsByKey.get('mail.api_key')
  const mailInUse = {
    provider: mailProvider.value,
    providerSource: mailProvider.source,
    from: mailFrom.value,
    fromSource: mailFrom.source,
    keySet: Boolean(mailKey.value),
    keySource: mailKey.source,
    keyLast4: mailKey.source === 'db' ? (mailKeyStatus?.last4 ?? null) : mailKeySeen?.last4 ?? null,
    keySeenAt: mailKey.source === 'db' ? (mailKeyStatus?.updated_at ?? null) : mailKeySeen?.firstSeenAt ?? null,
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
      <DeliveryReadiness health={deliveryHealth} notificationEnv={notificationEnv} />

      <section className="mb-6">
        <SectionHeader title="More settings" />
        <Card className="flex flex-wrap gap-4 p-4 text-[13px]">
          <Link href="/settings/scoring" className="text-accent hover:underline">Scoring — Engagement &amp; Fit models</Link>
          <Link href="/settings/tags" className="text-accent hover:underline">Data → Tags — manage, rename, merge</Link>
          <Link href="/settings/pools" className="text-accent hover:underline">Pools — industries a campaign can target</Link>
          <Link href="/settings/event-types" className="text-accent hover:underline">Data → Event types — register, relabel, switch off</Link>
        </Card>
      </section>

      {groups.map(({ group, items }) => {
        const nonSecret = items.filter((s) => !s.secret && s.key !== QUIET_START_KEY && s.key !== QUIET_END_KEY)
        const hasQuietHours = items.some((s) => s.key === QUIET_START_KEY)
        const secrets = items.filter((s) => s.secret)
        if (!items.length) return null
        return (
          <section key={group} className="mb-6">
            <SectionHeader title={group} />
            {SETTING_GROUP_HELP[group] ? <p className="-mt-1 mb-2 max-w-3xl text-[12.5px] leading-snug text-ink-muted">{SETTING_GROUP_HELP[group]}</p> : null}
            {group === 'Email sending' ? <MailInUse keySet={mailInUse.keySet} keySource={mailInUse.keySource} provider={mailInUse.provider} providerSource={mailInUse.providerSource} from={mailInUse.from} fromSource={mailInUse.fromSource} keyLast4={mailInUse.keyLast4} keySeenAt={mailInUse.keySeenAt} timeZone={timeZone} /> : null}
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
                  action={saveQuietHoursAction}
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
        <SectionHeader title="Data" meta="Custom fields, import, data tools, retention, and removing a person's data on request" />
        <Card className="p-4">
          <Link href="/settings/fields" className="text-[13px] font-medium text-accent hover:underline">
            Fields →
          </Link>
          <p className="mt-1 text-[12px] text-ink-faint">Define your own fields on a company or a contact.</p>
          <div className="mt-4 border-t border-hairline pt-4">
            {retentionNeedsMigration ? (
              <p className="text-[13px] text-ink-muted">Needs migration 0027 — it runs on the next production deploy.</p>
            ) : (
              <>
                {retentionPolicies.map((p) => (
                  <RetentionPolicyRow key={p.event_category} category={p.event_category} keepDays={p.keep_days} description={p.description} />
                ))}
                <RunSweepButton />
                <p className="mt-2 text-[12px] leading-relaxed text-ink-faint">
                  Leave a field blank to keep that kind of event forever. To remove one person&apos;s info entirely, use &quot;Forget this person&quot; on their lead page.
                </p>
              </>
            )}
          </div>
        </Card>
      </section>

      <section className="mb-6">
        <SectionHeader title="Team" meta="Who can sign in to this dashboard, and what they can do" />
        <p className="mb-2 text-[12.5px] text-ink-faint">
          <Link href="/settings/users" prefetch={false} className="underline hover:text-ink">Open Users &amp; roles</Link>
        </p>
        <Card className="p-4">
          {needsTeamMigration ? (
            <p className="text-[13px] text-ink-muted">Needs migration 0029 — it runs on the next production deploy.</p>
          ) : (
            <TeamSection members={teamMembers} isOwner={role === 'owner'} addAction={addTeamMemberAction} roleAction={changeTeamMemberRoleAction} removeAction={removeTeamMemberAction} />
          )}
        </Card>
      </section>

      <section className="mb-6">
        <SectionHeader title="Agents" meta="Which task kinds each agent picks up" />
        <Card className="p-4">
          <AgentsSection actors={actors} action={setAgentTakesKindsAction} />
        </Card>
      </section>

      <p className="text-[12px] leading-relaxed text-ink-faint">
        A value saved here is read before its environment variable by Instantly, email delivery, and verification. Other integrations still read their environment variable directly until they are wired up too.
      </p>
    </PageFrame>
  )
}
