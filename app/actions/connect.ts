'use server'

/**
 * Connecting agents: add an agent, mint / revoke its API keys, choose how each actor hears
 * about new work (delivery channels), quiet hours. Owner-only (plan 1.14): a minted key
 * works on /api/ops, so an editor who could mint one could give themselves owner-level
 * power. Every action checks the role itself (actorFor) and writes as the signed-in
 * owner's own actor id. Every change is in the activity log.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { OpsError } from '@/lib/ops/core'
import { addActor, mintAgentKey, revokeAgentKey } from '@/lib/notify/keys'
import { addChannel, deleteChannel, setChannelEnabled } from '@/lib/notify/deliver'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'

export interface OnceResult {
  ok: boolean
  message?: string
  /** Shown once (an API key, a webhook secret, an ntfy topic). */
  secret?: string
  secretLabel?: string
}

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const fail = (e: unknown): OnceResult => ({ ok: false, message: e instanceof OpsError || e instanceof AuthError ? e.message : 'That did not work: ' + (e as Error).message })

export async function addAgentAction(_prev: OnceResult | null, f: FormData): Promise<OnceResult> {
  let id: string
  try {
    const ME = await actorFor('owner')
    id = (await db().tx((q) => addActor(q, ME, { id: s(f, 'id'), display_name: s(f, 'display_name'), harness: s(f, 'harness') || null, kind: s(f, 'kind') === 'human' ? 'human' : 'agent' }), ME)).id
  } catch (e) {
    return fail(e)
  }
  revalidatePath('/agents')
  redirect(`/agents/${id}`)
}

export async function mintKeyAction(_prev: OnceResult | null, f: FormData): Promise<OnceResult> {
  const actor = s(f, 'actor_id')
  try {
    const ME = await actorFor('owner')
    const { key } = await db().tx((q) => mintAgentKey(q, ME, actor, s(f, 'label') || null), ME)
    revalidatePath(`/agents/${actor}`)
    return { ok: true, secret: key, secretLabel: 'API key', message: 'Copy it now: it is shown only once. The agent sends it as Authorization: Bearer <key>.' }
  } catch (e) {
    return fail(e)
  }
}

export async function revokeKeyAction(f: FormData) {
  const ME = await actorFor('owner')
  const actor = s(f, 'actor_id')
  if (s(f, 'confirm') !== 'yes') return
  await db().tx((q) => revokeAgentKey(q, ME, Number(s(f, 'key_id'))), ME)
  revalidatePath(`/agents/${actor}`)
}

export async function addChannelAction(_prev: OnceResult | null, f: FormData): Promise<OnceResult> {
  const actor = s(f, 'actor_id')
  try {
    const ME = await actorFor('owner')
    const r = await db().tx(
      (q) =>
        addChannel(q, ME, {
          actor_id: actor,
          kind: s(f, 'kind'),
          label: s(f, 'label') || null,
          url: s(f, 'url') || null,
          email: s(f, 'email') || null,
          via: s(f, 'via') || null,
          target: s(f, 'target') || null,
          to: s(f, 'to') || null,
          server: s(f, 'server') || null,
        }),
      ME,
    )
    revalidatePath(`/agents/${actor}`)
    if (r.secret) return { ok: true, secret: r.secret, secretLabel: 'Signing secret', message: 'Copy it into the agent: every POST carries X-Dashboard-Signature: sha256=HMAC(secret, timestamp + "." + body). Shown only once.' }
    if (r.topic) return { ok: true, secret: r.topic, secretLabel: 'ntfy topic', message: 'The relay subscribes to this topic. Keep it private: it is the only thing protecting the pings (they carry an id, never the content).' }
    return { ok: true, message: 'Added.' }
  } catch (e) {
    return fail(e)
  }
}

export async function toggleChannelAction(f: FormData) {
  const ME = await actorFor('owner')
  const actor = s(f, 'actor_id')
  await db().tx((q) => setChannelEnabled(q, ME, Number(s(f, 'channel_id')), s(f, 'enabled') === 'true'), ME)
  revalidatePath(`/agents/${actor}`)
}

export async function deleteChannelAction(f: FormData) {
  const ME = await actorFor('owner')
  const actor = s(f, 'actor_id')
  if (s(f, 'confirm') !== 'yes') return
  await db().tx((q) => deleteChannel(q, ME, Number(s(f, 'channel_id'))), ME)
  revalidatePath(`/agents/${actor}`)
}

export async function setQuietShabbosAction(f: FormData) {
  const ME = await actorFor('owner')
  const actor = s(f, 'actor_id')
  const on = s(f, 'on') === 'true'
  await db().tx(async (q) => {
    await q.query('update lp.actors set quiet_shabbos = $2 where id = $1', [actor, on])
    await q.query(`insert into lp.events (actor, kind, summary, entity_type, entity_id) values ($1, 'actor.quiet_hours', $2, 'actor', $3)`, [
      ME,
      `Shabbos quiet hours ${on ? 'on' : 'off'} for ${actor}`,
      actor,
    ])
  }, ME)
  revalidatePath(`/agents/${actor}`)
}
