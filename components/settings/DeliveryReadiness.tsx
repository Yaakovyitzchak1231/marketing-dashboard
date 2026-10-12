import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { FEATURE_TITLES, type EnvKeyStatus } from '@/lib/setup/env'
import type { DeliveryHealth } from '@/lib/notify/health'

export function DeliveryReadiness({ health, notificationEnv }: { health: DeliveryHealth; notificationEnv: EnvKeyStatus[] }) {
  return (
    <section className="mb-6">
      <SectionHeader title="Agent delivery" meta="Check-ins, queued notifications, and mail prerequisites" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-4" data-testid="setup-delivery">
          {health.available ? (
            health.agents.length ? (
              <div className="divide-y divide-line-soft">
                {health.agents.map((agent) => (
                  <div key={agent.id} className="py-2 first:pt-0 last:pb-0">
                    <p className="text-[13px] font-medium text-ink">{agent.display_name} is @{agent.id}</p>
                    <p className="mt-1 text-[12px] text-ink-muted">Unread: {agent.unread}. Held: {agent.held}. Failed: {agent.failed}. No channel: {agent.no_channel}.</p>
                    <p className="mt-1 text-[12px] text-ink-muted">Last check-in: {agent.last_seen_at ? new Date(agent.last_seen_at).toLocaleString() : 'not recorded'}</p>
                    <p className="mt-1 text-[12px] text-ink-faint">Channels: {agent.channels.length ? agent.channels.join(', ') : 'none'}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">No active agents to inspect.</p>
            )
          ) : (
            <p className="text-[13px] text-ink-muted">{health.error}</p>
          )}
        </Card>
        <Card className="p-4" data-testid="setup-feature-notifications">
          <h2 className="text-[13px] font-semibold text-ink">{FEATURE_TITLES.notifications}</h2>
          <ul className="mt-2 space-y-2">
            {notificationEnv.map((key) => (
              <li key={key.key} className="text-[12px] leading-snug text-ink-muted">
                <code className="font-numeric text-ink">{key.key}</code>{' '}
                <span>{key.set ? 'set' : 'not set'}</span>
                <p className="mt-0.5">{key.purpose}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </section>
  )
}
