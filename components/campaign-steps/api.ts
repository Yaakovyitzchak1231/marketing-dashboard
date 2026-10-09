/** fetch wrapper for /api/campaign-steps/:id (client side). */
export async function call(campaignId: number, path: string, method: string, body?: unknown): Promise<{ ok: boolean; error?: string; [k: string]: unknown }> {
  try {
    const res = await fetch(`/api/campaign-steps/${campaignId}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const j = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null
    if (!res.ok) return { ok: false, error: j?.error ?? `That didn’t work (${res.status}).` }
    return { ...(j ?? {}), ok: true }
  } catch {
    return { ok: false, error: 'Couldn’t reach the server.' }
  }
}
