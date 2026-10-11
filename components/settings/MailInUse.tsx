import { Card, Pill } from '@/components/dashboard/primitives'
import { formatSetAt, maskedTail } from '@/lib/settings/mask'

/**
 * What email sending actually uses right now. Sending reads MAIL_PROVIDER,
 * MAIL_API_KEY and MAIL_FROM from the server env (Vercel), so the fields below
 * are saved but do not change sending. Only the key's last 4 reach this screen.
 */
export function MailInUse({
  provider,
  from,
  keySet,
  keyLast4,
  keySeenAt,
  timeZone,
}: {
  keySet: boolean
  provider: string | null
  from: string | null
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
        <Pill tone="neutral">set in Vercel</Pill>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[12.5px]">
        <dt className="text-ink-muted">Provider</dt>
        <dd className="text-ink">{provider ? provider : <span className="font-semibold text-warn">Not set</span>}</dd>
        <dt className="text-ink-muted">From</dt>
        <dd className="text-ink break-all">{from ? from : <span className="font-semibold text-warn">Not set</span>}</dd>
        <dt className="text-ink-muted">API key</dt>
        <dd className="text-ink">
          {keySet ? (
            <>
              {keyLast4 ? maskedTail(keyLast4) : 'set'}
              {seen ? <span className="text-ink-muted"> · first seen {seen}</span> : null}
            </>
          ) : (
            <span className="font-semibold text-warn">Not set</span>
          )}
        </dd>
      </dl>
      <p className="mt-2 text-[12px] leading-snug text-ink-muted">
        Sending uses these values from Vercel (Settings → Environment Variables: MAIL_PROVIDER, MAIL_API_KEY, MAIL_FROM). The fields below are saved here but don&apos;t change sending yet.
      </p>
    </Card>
  )
}
