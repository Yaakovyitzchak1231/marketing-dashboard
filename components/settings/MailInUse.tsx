import { Card, Pill } from '@/components/dashboard/primitives'
import { formatSetAt, maskedTail } from '@/lib/settings/mask'

type ConfigSource = 'db' | 'env' | 'unset'

function sourceLabel(source: ConfigSource): string {
  return source === 'db' ? 'Settings' : source === 'env' ? 'Vercel' : 'not set'
}

/** What email sending uses now. Settings are resolved before environment fallbacks. */
export function MailInUse({
  provider,
  providerSource,
  from,
  fromSource,
  keySet,
  keySource,
  keyLast4,
  keySeenAt,
  timeZone,
}: {
  keySet: boolean
  keySource: ConfigSource
  provider: string | null
  providerSource: ConfigSource
  from: string | null
  fromSource: ConfigSource
  keyLast4: string | null
  keySeenAt: string | null
  timeZone?: string
}) {
  const ready = Boolean(provider && from && keySet)
  const seen = formatSetAt(keySeenAt, timeZone)
  return (
    <Card className="mb-2 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[13px] font-semibold text-ink">In use now</p>
        {ready ? <Pill tone="good">Sending</Pill> : <Pill tone="warn">Not sending yet</Pill>}
        <Pill tone="neutral">Settings first, then Vercel</Pill>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        <dt className="text-ink-muted">Provider</dt>
        <dd className="text-ink">
          {provider ? provider : <span className="font-semibold text-warn">Not set</span>}
          {provider ? <span className="text-ink-muted"> · from {sourceLabel(providerSource)}</span> : null}
        </dd>
        <dt className="text-ink-muted">From</dt>
        <dd className="break-all text-ink">
          {from ? from : <span className="font-semibold text-warn">Not set</span>}
          {from ? <span className="text-ink-muted"> · from {sourceLabel(fromSource)}</span> : null}
        </dd>
        <dt className="text-ink-muted">API key</dt>
        <dd className="text-ink">
          {keySet ? (
            <>
              {keyLast4 ? maskedTail(keyLast4) : 'set'} · from {sourceLabel(keySource)}
              {seen ? <span className="text-ink-muted"> · {keySource === 'db' ? 'saved' : 'first seen'} {seen}</span> : null}
            </>
          ) : (
            <span className="font-semibold text-warn">Not set</span>
          )}
        </dd>
      </dl>
      <p className="mt-2 text-[12px] leading-snug text-ink-muted">
        Sending uses the effective values shown here. Values saved on Settings take precedence over Vercel environment variables.
      </p>
    </Card>
  )
}
