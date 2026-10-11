import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PageShell } from '@/components/app/PageShell'
import { VercelLinks } from '@/components/app/SetupNeeded'
import { Card, Pill } from '@/components/dashboard/primitives'
import { getDb } from '@/lib/db'
import { envStatus, FEATURE_TITLES, type SetupFeature } from '@/lib/setup/env'
import { readDbStatus } from '@/lib/setup/db-status'
import { readDeliveryHealth } from '@/lib/notify/health'
import { recordEnvSecretsSeen } from '@/lib/settings/env-seen'
import { formatSetAt, last4Of, maskedTail } from '@/lib/settings/mask'
import { resolveTimezone } from '@/lib/dashboard/dates'

export const dynamic = 'force-dynamic'

const FEATURES: SetupFeature[] = ['leads', 'dashboard', 'agents', 'notifications', 'login']
const CODE = 'rounded bg-canvas px-1 font-numeric text-[12px] text-ink'

function migrationCount(): number | null {
  try {
    return readdirSync(join(process.cwd(), 'db', 'migrations')).filter((f) => f.endsWith('.sql')).length
  } catch {
    return null
  }
}

/** Settings: every key the app reads, whether it is set (never its value), and how to set it. */
export default async function SetupPage() {
  const connection = getDb()
  const [db, delivery] = await Promise.all([readDbStatus(connection), readDeliveryHealth(connection)])
  const total = migrationCount()
  // Last 4 + first-seen time for every set key (only those 4 characters are rendered; the value never is).
  const setKeys = FEATURES.flatMap((f) => envStatus(f).filter((k) => k.set).map((k) => k.key))
  const seen = connection ? await recordEnvSecretsSeen(connection, setKeys) : new Map<string, { last4: string | null; firstSeenAt: string | null }>()
  const tz = resolveTimezone(process.env.DASHBOARD_TZ)
  return (
    <PageShell title="Settings" meta="Keys live in Vercel. This page shows whether each one is set, never its value.">
      <div className="mx-auto max-w-[760px] space-y-4">
        <Card className="px-5 py-5">
          <div data-testid="setup-db">
            <h2 className="text-[15px] font-semibold text-ink">Lead database</h2>
            <p className="mt-1 text-[13px] text-ink-muted">
              {!db.connected
                ? 'Not connected: DATABASE_URL is not set. Steps below.'
                : db.error
                  ? db.error
                  : `Connected. ${db.migrationsApplied.length}${total ? ` of ${total}` : ''} migrations applied. ${
                      db.contacts == null || db.companies == null
                        ? ''
                        : `${db.contacts.toLocaleString('en-US')} contacts, ${db.companies.toLocaleString('en-US')} companies.`
                    }`}
            </p>
          </div>
        </Card>
        <Card className="px-5 py-5">
          <section data-testid="setup-delivery">
            <h2 className="text-[15px] font-semibold text-ink">Can the agents hear you?</h2>
            <p className="mt-1 text-[13px] text-ink-muted">
              A task saved is not a task received. Email and webhooks need working destinations; pull, stream and MCP need a connected listener. Use the exact agent ID when assigning or mentioning someone (Tab is @tab).
            </p>
            {!delivery.available ? <p className="mt-3 text-[13px] text-ink-muted">{delivery.error}</p> : (
              <ul className="mt-3 space-y-3">
                {delivery.agents.map((a) => (
                  <li key={a.id} className="border-t border-line pt-3 text-[13px]">
                    <p className="font-medium text-ink">{a.display_name} <span className="font-normal text-ink-muted">@{a.id}</span></p>
                    <p className="text-ink-muted">Enabled channels: {a.channels.length ? a.channels.join(', ') : 'none — add a channel on the agent’s page'}.</p>
                    <p className="text-ink-muted">Unread: {a.unread}. Held: {a.held}. Failed: {a.failed}. Without a channel: {a.no_channel}.</p>
                    <p className="text-ink-muted">Last check-in: {a.last_seen_at ? new Date(a.last_seen_at).toISOString() : 'not recorded'}.</p>
                  </li>
                ))}
                {!delivery.agents.length && <li className="text-[13px] text-ink-muted">No active agents are registered.</li>}
              </ul>
            )}
          </section>
        </Card>
        {FEATURES.map((f) => {
          const keys = envStatus(f)
          return (
            <Card key={f} className="px-5 py-5">
              <section data-testid={`setup-feature-${f}`}>
                <h2 className="text-[15px] font-semibold text-ink">{FEATURE_TITLES[f]}</h2>
                <ul className="mt-3 space-y-3">
                  {keys.map((k) => (
                    <li key={k.key} className="text-[13px]">
                      <div className="flex flex-wrap items-center gap-2">
                        <code className={CODE}>{k.key}</code>
                        <Pill tone={k.required ? 'accent' : 'neutral'}>{k.required ? 'Required' : 'Optional'}</Pill>
                        <Pill tone={k.set ? 'good' : k.required ? 'warn' : 'neutral'}>{k.set ? `Set · ${maskedTail(seen.get(k.key)?.last4 ?? last4Of(process.env[k.key]))}` : 'Missing'}</Pill>
                      </div>
                      <p className="mt-1 text-ink-muted">{k.purpose}</p>
                      {k.set ? (
                        <p className="mt-0.5 text-[12px] text-ink-faint">
                          {seen.get(k.key)?.firstSeenAt ? `First seen ${formatSetAt(seen.get(k.key)?.firstSeenAt ?? null, tz)} (Vercel env carries no set date)` : 'Set in Vercel env; the date it was set is not recorded'}
                        </p>
                      ) : null}
                      {k.set ? null : (
                        <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-ink">
                          {k.steps.map((s, i) => (
                            <li key={i}>{s}</li>
                          ))}
                        </ol>
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            </Card>
          )
        })}
        <VercelLinks />
      </div>
    </PageShell>
  )
}
