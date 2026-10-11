import type { Queryable } from '../db/types'

export interface AgentDeliveryHealth {
  id: string
  display_name: string
  last_seen_at: Date | null
  channels: string[]
  unread: number
  held: number
  failed: number
  no_channel: number
}

export type DeliveryHealth =
  | { available: true; agents: AgentDeliveryHealth[] }
  | { available: false; error: string }

/** Read-only operational evidence. Never returns channel configuration, keys or message text. */
export async function readDeliveryHealth(db: Queryable | null): Promise<DeliveryHealth> {
  if (!db) return { available: false, error: 'Connect the lead database to inspect agent delivery.' }
  try {
    const { rows } = await db.query<AgentDeliveryHealth>(`
      select a.id, a.display_name, a.last_seen_at,
             array(select distinct c.kind from lp.delivery_channels c
                   where c.actor_id = a.id and c.enabled order by c.kind) as channels,
             count(n.id)::int as unread,
             count(n.id) filter (where s.status = 'held')::int as held,
             count(n.id) filter (where s.status = 'failed')::int as failed,
             count(n.id) filter (where s.status = 'no_channel')::int as no_channel
        from lp.actors a
        left join lp.notifications n on n.recipient = a.id and n.read_at is null
        left join lp.notification_delivery s on s.notification_id = n.id
       where a.kind = 'agent' and a.active and a.id not in ('system', 'instantly-ai')
       group by a.id, a.display_name, a.last_seen_at order by a.display_name`)
    return { available: true, agents: rows }
  } catch {
    return { available: false, error: 'Delivery health is unavailable. Check the database connection and notification migrations.' }
  }
}
