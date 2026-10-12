import { fetchRole } from '@/components/auth/useRole'
import { failedWriteText, thrownWriteText } from '@/components/auth/viewOnly'

/** fetch wrapper for /api/campaign-steps/:id (client side). */
export async function call(campaignId: number, path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch(`/api/campaign-steps/${campaignId}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!res.ok) return { ok: false, error: failedWriteText(res.status, j?.error, `That didn’t work (${res.status}).`, await fetchRole()) }
    return { ...(j ?? {}), ok: true }
  } catch (err) {
    return { ok: false, error: thrownWriteText(err, await fetchRole()) }
  }
}
