import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { PageShell } from '@/components/app/PageShell'
import { VercelLinks } from '@/components/app/SetupNeeded'
import { Card, Pill } from '@/components/dashboard/primitives'
import { getDb } from '@/lib/db'
import { envStatus, FEATURE_TITLES, type SetupFeature } from '@/lib/setup/env'
import { readDbStatus } from '@/lib/setup/db-status'

export const dynamic = 'force-dynamic'

const FEATURES: SetupFeature[] = ['leads', 'dashboard', 'agents', 'login']
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
  const db = await readDbStatus(getDb())
  const total = migrationCount()
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
                        <Pill tone={k.set ? 'good' : k.required ? 'warn' : 'neutral'}>{k.set ? 'Set' : 'Missing'}</Pill>
                      </div>
                      <p className="mt-1 text-ink-muted">{k.purpose}</p>
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
