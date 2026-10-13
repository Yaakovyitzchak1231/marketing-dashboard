import Link from 'next/link'
import type { ReactNode } from 'react'
import { Card, Pill } from '@/components/dashboard/primitives'
import { ForAdmins } from '@/components/ui/Details'
import { buttonClass } from '@/components/ui/Button'
import { envStatus, vercelEnvSettingsUrl, vercelProjectUrl, type SetupFeature } from '@/lib/setup/env'

const CODE = 'rounded bg-canvas px-1 font-numeric text-xs text-ink'
const BTN_PRIMARY = buttonClass({ variant: 'primary' })
const BTN = buttonClass({ variant: 'secondary' })

/** Links into this project's Vercel settings. Server-rendered from Vercel's own system variables. */
export function VercelLinks() {
  const env = vercelEnvSettingsUrl()
  const project = vercelProjectUrl()
  return (
    <div className="flex flex-wrap gap-2" data-testid="vercel-links">
      <a href={env.url} target="_blank" rel="noopener noreferrer" className={BTN_PRIMARY} data-testid="vercel-env-link">
        {env.exact ? 'Open Vercel environment variables' : 'Open Vercel'}
      </a>
      {env.exact ? (
        <a href={project} target="_blank" rel="noopener noreferrer" className={BTN}>
          Open the project in Vercel (Storage, Deployments)
        </a>
      ) : null}
    </div>
  )
}

/**
 * The "Setup needed" card: which keys are missing, required vs optional, and
 * click-by-click steps for each missing one. Shows whether a key is set, never its value.
 */
export function SetupNeeded({
  features,
  title,
  intro,
  testId,
}: {
  features: SetupFeature[]
  title: string
  intro?: ReactNode
  testId?: string
}) {
  const keys = features.flatMap((f) => envStatus(f))
  const missing = keys.filter((k) => !k.set)
  const firstMissingRequired = missing.find((k) => k.required)
  return (
    <Card className="mx-auto max-w-[680px] px-5 py-6 sm:px-7 sm:py-7">
      <div data-testid={testId ?? 'setup-needed'}>
        <p className="text-2xs font-semibold uppercase tracking-[0.06em] text-warn">Setup needed</p>
        <h2 className="mt-1.5 text-lg font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {intro ? <p className="mt-2 text-sm leading-relaxed text-ink-muted">{intro}</p> : null}

        <p className="mt-3 text-sm text-ink-muted">
          {missing.length
            ? `${missing.length} connection${missing.length === 1 ? '' : 's'} still need${missing.length === 1 ? 's' : ''} to be added by whoever manages the hosting. The steps are below.`
            : 'Everything this needs is connected.'}
        </p>
        <ForAdmins summary="Setup steps (for admins)" className="mt-4">
        <ul className="divide-y divide-line-soft rounded-card border border-line" data-testid="setup-keys">
          {keys.map((k) => (
            <li key={k.key} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm" data-testid={`setup-key-${k.key}`}>
              <code className={CODE}>{k.key}</code>
              <Pill tone={k.required ? 'accent' : 'neutral'}>{k.required ? 'Required' : 'Optional'}</Pill>
              <Pill tone={k.set ? 'good' : k.required ? 'warn' : 'neutral'}>{k.set ? 'Set' : 'Missing'}</Pill>
              <span className="w-full text-xs leading-snug text-ink-faint sm:w-auto sm:flex-1">{k.purpose}</span>
            </li>
          ))}
        </ul>

        {missing.map((k) => (
          <section key={k.key} className="mt-5" data-testid={`setup-steps-${k.key}`}>
            <h3 className="text-sm font-semibold text-ink">
              {k.automatic ? 'Create ' : 'Add '}
              <code className={CODE}>{k.key}</code>
              {k.required ? null : <span className="font-normal text-ink-faint"> (optional)</span>}
            </h3>
            <ol className="mt-2 list-decimal space-y-1.5 pl-5 text-sm leading-relaxed text-ink">
              {k.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          </section>
        ))}

        </ForAdmins>
        <div className="mt-5">
          <VercelLinks />
        </div>

        <p className="mt-5 border-t border-line-soft pt-4 text-xs text-ink-faint">
          {firstMissingRequired
            ? 'Keys live in Vercel, never in this app. '
            : 'Every required key is set. If this screen is still showing, redeploy so the new keys take effect. '}
          This page only shows whether a key is set, never its value.{' '}
          <Link href="/setup" className="text-accent hover:underline">
            All settings
          </Link>
        </p>
      </div>
    </Card>
  )
}
