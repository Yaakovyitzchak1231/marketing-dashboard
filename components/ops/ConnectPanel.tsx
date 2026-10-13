import type { Queryable } from '@/lib/db/types'
import { listAgentKeys } from '@/lib/notify/keys'
import { listChannels } from '@/lib/notify/deliver'
import {
  addChannelAction, deleteChannelAction, mintKeyAction, revokeKeyAction, setQuietShabbosAction, toggleChannelAction,
} from '@/app/actions/connect'
import { sendMessageAction } from '@/app/actions/ops'
import { OnceForm } from './OnceForm'
import { Ago, btnCls, inputCls, primaryBtnCls } from './bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { formatSetAt, maskedTail } from '@/lib/settings/mask'
import { resolveTimezone } from '@/lib/dashboard/dates'

const KIND_TEXT: Record<string, string> = {
  webhook: 'Webhook: a signed POST to its URL the moment something happens',
  ntfy: 'Wake-up ping: a private ntfy topic its relay listens on (for agents with no public address, like Hermes)',
  email: 'Email: for agents whose door is a mailbox (Tab)',
  stream: 'Live stream: it holds GET /api/ops/stream open',
  pull: 'Pull: it reads GET /api/ops/feed when it can',
  mcp: 'MCP: it connects to /api/ops/mcp and calls get_events',
  relay: 'Relay: another agent carries it to a phone (e.g. Hermes sends a WhatsApp)',
}

function describe(c: { kind: string; config: Record<string, unknown> }): string {
  if (c.kind === 'webhook') return String(c.config.url ?? '')
  if (c.kind === 'email') return String(c.config.to ?? '')
  if (c.kind === 'ntfy') return `${String(c.config.server ?? 'https://ntfy.sh')} · topic …${String(c.config.topic ?? '').slice(-4)}`
  if (c.kind === 'relay') return `${String(c.config.target ?? 'whatsapp')} via ${String(c.config.via ?? '?')}${c.config.to ? ` to ${String(c.config.to)}` : ''}`
  return ''
}

export async function ConnectPanel({
  db,
  actor,
  agents,
  now,
}: {
  db: Queryable
  actor: { id: string; kind: string; display_name: string; quiet_shabbos?: boolean | null }
  agents: { id: string; display_name: string }[]
  now: Date
}) {
  const isAgent = actor.kind === 'agent'
  const [channels, keys] = await Promise.all([listChannels(db, actor.id), isAgent ? listAgentKeys(db, actor.id) : Promise.resolve([])])
  const live = channels.filter((c) => c.enabled)
  return (
    <>
      {actor.id !== 'owner' ? (
        <section>
          <SectionHeader title={`Message ${actor.display_name}`} />
          <Card className="p-3">
            <form action={sendMessageAction} className="space-y-2">
              <input type="hidden" name="to" value={actor.id} />
              <textarea name="body" required rows={2} className={inputCls} placeholder={`Goes to ${actor.display_name} right away`} />
              <button type="submit" className={`${primaryBtnCls} w-full`}>Send</button>
            </form>
          </Card>
        </section>
      ) : null}
      <section>
        <SectionHeader title="How they hear about new work" meta={<span className="tabular-nums">{live.length} on</span>} />
        <Card className="divide-y divide-line-soft">
          {channels.length ? (
            channels.map((c) => (
              <div key={c.id} className="px-3 py-2 text-xs leading-snug">
                <p className="flex items-baseline gap-2">
                  <span className={`font-medium ${c.enabled ? 'text-ink' : 'text-ink-faint line-through'}`}>{c.label || c.kind}</span>
                  <span className="min-w-0 flex-1 truncate text-ink-faint">{describe(c)}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-faint">
                  {c.last_error && (!c.last_ok_at || (c.last_error_at && new Date(c.last_error_at) > new Date(c.last_ok_at))) ? (
                    <span className="text-bad">last try failed <Ago at={c.last_error_at} now={now} />: {c.last_error.slice(0, 120)}</span>
                  ) : c.last_ok_at ? (
                    <>worked <Ago at={c.last_ok_at} now={now} /></>
                  ) : (
                    'not used yet'
                  )}
                </p>
                <div className="mt-1 flex gap-3 text-xs">
                  <form action={toggleChannelAction}>
                    <input type="hidden" name="actor_id" value={actor.id} />
                    <input type="hidden" name="channel_id" value={c.id} />
                    <input type="hidden" name="enabled" value={c.enabled ? 'false' : 'true'} />
                    <button type="submit" className="text-accent">{c.enabled ? 'Turn off' : 'Turn on'}</button>
                  </form>
                  <form action={deleteChannelAction}>
                    <input type="hidden" name="actor_id" value={actor.id} />
                    <input type="hidden" name="channel_id" value={c.id} />
                    <input type="hidden" name="confirm" value="yes" />
                    <button type="submit" className="text-bad">Remove</button>
                  </form>
                </div>
              </div>
            ))
          ) : (
            <EmptyNote>
              {isAgent
                ? `None yet: ${actor.display_name} only sees new work when it checks in. Add a channel so it hears instantly.`
                : 'Shows live in the dashboard. Add a WhatsApp relay to get pings on your phone.'}
            </EmptyNote>
          )}
          <details className="p-3">
            <summary className="cursor-pointer text-xs font-medium text-accent">Add a channel</summary>
            <OnceForm action={addChannelAction} submitLabel="Add channel" className="mt-2" buttonClassName={`${btnCls} w-full`}>
              <input type="hidden" name="actor_id" value={actor.id} />
              <select name="kind" className={inputCls} defaultValue={isAgent ? 'webhook' : 'relay'}>
                {(isAgent ? ['webhook', 'ntfy', 'email', 'mcp', 'stream', 'pull'] : ['relay', 'email', 'webhook']).map((k) => (
                  <option key={k} value={k}>{KIND_TEXT[k]}</option>
                ))}
              </select>
              <input name="label" maxLength={80} className={inputCls} placeholder="Label (optional)" />
              <input name="url" className={inputCls} placeholder="Webhook URL (https://…), for webhook" />
              <input name="email" className={inputCls} placeholder="Email address, for email" />
              {!isAgent ? (
                <>
                  <select name="via" className={inputCls} defaultValue="hermes">
                    {agents.map((a) => <option key={a.id} value={a.id}>Relay via {a.display_name}</option>)}
                  </select>
                  <input name="to" className={inputCls} placeholder="WhatsApp number or chat (optional; the relay's default otherwise)" />
                </>
              ) : (
                <input name="server" className={inputCls} placeholder="ntfy server (default https://ntfy.sh), for ntfy" />
              )}
            </OnceForm>
          </details>
        </Card>
      </section>
      {!isAgent ? (
        <section>
          <SectionHeader title="Quiet hours" />
          <Card className="flex items-center gap-3 p-3 text-xs">
            <p className="min-w-0 flex-1 text-ink-muted">
              Shabbos (Baltimore, candle lighting to nightfall): phone pings {actor.quiet_shabbos ? 'wait until after Shabbos' : 'go out any time'}. The dashboard keeps working either way.
            </p>
            <form action={setQuietShabbosAction}>
              <input type="hidden" name="actor_id" value={actor.id} />
              <input type="hidden" name="on" value={actor.quiet_shabbos ? 'false' : 'true'} />
              <button type="submit" className={btnCls}>{actor.quiet_shabbos ? 'Turn off' : 'Turn on'}</button>
            </form>
          </Card>
        </section>
      ) : null}
      {isAgent ? (
        <section>
          <SectionHeader title="API keys" meta={<span className="tabular-nums">{keys.filter((k) => !k.revoked_at).length} live</span>} />
          <Card className="divide-y divide-line-soft">
            {keys.map((k) => (
              <div key={k.id} className={`flex items-center gap-2 px-3 py-2 text-xs ${k.revoked_at ? 'text-ink-faint' : 'text-ink'}`}>
                <span className="font-mono">{maskedTail(k.hint)}</span>
                <span className="min-w-0 flex-1 truncate text-ink-faint">
                  {k.label ? `${k.label} · ` : ''}
                  {`created ${formatSetAt(k.created_at, resolveTimezone(process.env.DASHBOARD_TZ)) ?? '(time not recorded)'} · `}
                  {k.revoked_at ? <>revoked <Ago at={k.revoked_at} now={now} /></> : k.last_used_at ? <>used <Ago at={k.last_used_at} now={now} /></> : 'never used'}
                </span>
                {!k.revoked_at ? (
                  <form action={revokeKeyAction}>
                    <input type="hidden" name="actor_id" value={actor.id} />
                    <input type="hidden" name="key_id" value={k.id} />
                    <input type="hidden" name="confirm" value="yes" />
                    <button type="submit" className="text-bad">Revoke</button>
                  </form>
                ) : null}
              </div>
            ))}
            <OnceForm action={mintKeyAction} submitLabel="Create a key" className="p-3" buttonClassName={`${btnCls} w-full`}>
              <input type="hidden" name="actor_id" value={actor.id} />
              <input name="label" maxLength={80} className={inputCls} placeholder="What it is for (e.g. OVH relay)" />
            </OnceForm>
          </Card>
        </section>
      ) : null}
    </>
  )
}
