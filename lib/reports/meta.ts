/**
 * Campaign segment + angle, as a human set them (lp.campaign_meta). Nothing is
 * guessed into the table: a campaign without a row is "angle not set". The
 * name-based hint below is only ever shown as a placeholder in the editor.
 */
import type { Queryable } from '@/lib/db/types'
import { mapPoolFkError } from '@/lib/pools/store'

/** Any pool slug in lp.pools (lib/pools/store.ts) — campaign-agnostic, not a fixed list. */
export type Segment = string
/** Best-effort labels for the four original pools, used only where there is no DB round trip. */
export const SEGMENT_LABEL: Record<string, string> = { jeweler: 'Jewelers', ai_agency: 'AI agencies', ai_builder: 'AI builders', other: 'Other' }
const SEGMENT_RE = /^[a-z][a-z0-9_]{0,40}$/

export interface CampaignMeta {
  campaign_id: string
  campaign_name: string | null
  segment: Segment | null
  angle: string | null
  updated_by: string | null
  updated_at: string
}

export async function listCampaignMeta(q: Queryable): Promise<Map<string, CampaignMeta>> {
  const { rows } = await q.query<CampaignMeta>('select * from lp.campaign_meta')
  return new Map(rows.map((r) => [r.campaign_id, r]))
}

export async function saveCampaignMeta(
  q: Queryable,
  actor: string,
  input: { campaign_id: string; campaign_name?: string | null; segment?: string | null; angle?: string | null },
): Promise<CampaignMeta> {
  const id = String(input.campaign_id ?? '').trim()
  if (!id || id.length > 100) throw new Error('campaign_id is required')
  const seg = input.segment && SEGMENT_RE.test(input.segment) ? input.segment : null
  const angle = input.angle && input.angle.trim() ? input.angle.trim().slice(0, 80) : null
  try {
    const { rows } = await q.query<CampaignMeta>(
      `insert into lp.campaign_meta (campaign_id, campaign_name, segment, angle, updated_by)
       values ($1, $2, $3, $4, $5)
       on conflict (campaign_id) do update set campaign_name = coalesce(excluded.campaign_name, lp.campaign_meta.campaign_name),
         segment = excluded.segment, angle = excluded.angle, updated_by = excluded.updated_by, updated_at = now()
       returning *`,
      [id, input.campaign_name ?? null, seg, angle, actor],
    )
    return rows[0]
  } catch (e) {
    mapPoolFkError(e, seg)
    throw e
  }
}

/**
 * A hint for the editor's placeholder only, e.g. "TapDash Oct8 - Segment 1 Held Payouts" -> "Held Payouts".
 * Never stored, never used to group numbers.
 */
export function angleHintFromName(name: string): string | null {
  const tail = name.split(/\s[-–—]\s/).pop() ?? ''
  const cleaned = tail.replace(/^segment\s*\d+\s*/i, '').trim()
  return cleaned && cleaned !== name.trim() ? cleaned : null
}

export function segmentHintFromName(name: string): Segment | null {
  if (/jewel/i.test(name)) return 'jeweler'
  if (/builder/i.test(name)) return 'ai_builder'
  if (/\b(ai|agenc)/i.test(name)) return 'ai_agency'
  return null
}
