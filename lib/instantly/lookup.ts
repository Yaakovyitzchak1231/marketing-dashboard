import 'server-only'
/**
 * Read-only Instantly lookups the approval gate uses to build a preview for an
 * agent's request (duplicate check, current campaign status). Reads only;
 * nothing here changes Instantly.
 */
import { clientFromEnv } from '@/lib/instantly/client'
import { listCampaigns, listLeadsByEmail } from '@/lib/instantly/endpoints'
import { campaignStatus } from '@/lib/dashboard/metrics'

export function instantlyLookupFromEnv(): ((emails: string[]) => Promise<string[]>) | null {
  const reader = clientFromEnv()
  if (!reader) return null
  return async (emails: string[]) => (await listLeadsByEmail(reader, emails)).map((l) => String(l.email ?? '')).filter(Boolean)
}

/** The campaign's current status word ('active', 'paused', ...), or null when it can't be read. */
export async function campaignStatusFromEnv(campaignId: string): Promise<string | null> {
  const reader = clientFromEnv()
  if (!reader) return null
  try {
    const page = await listCampaigns(reader)
    const c = page.items.find((x) => x.id === campaignId)
    return c ? campaignStatus(c.status) : null
  } catch {
    return null
  }
}
