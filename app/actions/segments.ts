'use server'

/**
 * The segment builder's buttons (plan 2.2/2.3/2.11). Same functions an agent
 * reaches through /api/ops (lib/segments/ops.ts) -- every action here answers
 * {ok, ...} instead of throwing, so the UI shows a plain error, never a crash.
 */
import { revalidatePath } from 'next/cache'
import { getDb } from '@/lib/db'
import { actorFor } from '@/lib/auth/act'
import { AuthError } from '@/lib/auth/roles'
import { DefinitionError, validateDefinition } from '@/lib/segments/definition'
import { allFields, type FieldDef } from '@/lib/segments/fields'
import { compileSegment, countSegment, matchingIds, sampleRows, type SegmentCounts } from '@/lib/segments/compile'
import { readback } from '@/lib/segments/readback'
import {
  archiveSegment, createSegment, getSegment, listSegments, SegmentError, updateSegment, type Segment,
} from '@/lib/segments/store'
import { getSegmentAiConfig, isSegmentAiConfigured, segmentFromText, SegmentAiError, type SegmentFromTextOutcome } from '@/lib/segments/ai'
import { listPresets, getPreset, type SegmentPreset } from '@/lib/segments/presets'
import { listCampaigns } from '@/lib/campaigns/store'
import { emitLeadEvents } from '@/lib/events/emit'

type Fail = { ok: false; error: string }

function db() {
  const d = getDb()
  if (!d) throw new SegmentError('The lead database is not connected (DATABASE_URL is not set).')
  return d
}

function fail(e: unknown): Fail {
  if (e instanceof AuthError) return { ok: false, error: e.message }
  if (e instanceof SegmentError || e instanceof DefinitionError || e instanceof SegmentAiError) return { ok: false, error: e.message }
  console.error('segment action failed', (e as Error).message)
  return { ok: false, error: 'That could not be saved right now.' }
}

function touch(id?: number) {
  revalidatePath('/segments')
  if (id != null) revalidatePath(`/segments/${id}`)
}

export async function listFieldsAction(): Promise<{ ok: true; fields: FieldDef[] } | Fail> {
  try {
    return { ok: true, fields: allFields() }
  } catch (e) {
    return fail(e)
  }
}

export async function listCampaignsForPickerAction(): Promise<{ ok: true; campaigns: { id: number; name: string }[] } | Fail> {
  try {
    const campaigns = await listCampaigns(db(), {})
    return { ok: true, campaigns: campaigns.map((c) => ({ id: c.id, name: c.name })) }
  } catch (e) {
    return fail(e)
  }
}

export async function listPresetsAction(): Promise<{ ok: true; presets: SegmentPreset[] } | Fail> {
  try {
    return { ok: true, presets: listPresets() }
  } catch (e) {
    return fail(e)
  }
}

export async function aiConfiguredAction(): Promise<{ ok: true; configured: boolean } | Fail> {
  try {
    return { ok: true, configured: await isSegmentAiConfigured() }
  } catch (e) {
    return fail(e)
  }
}

export async function segmentFromTextAction(text: string): Promise<{ ok: true; result: SegmentFromTextOutcome } | Fail> {
  try {
    // Spends AI credits, so it is a write for role purposes even though it saves nothing.
    await actorFor('editor')
    const cfg = await getSegmentAiConfig()
    const result = await segmentFromText(text, { config: cfg })
    return { ok: true, result }
  } catch (e) {
    return fail(e)
  }
}

export interface PreviewResult { entity: 'company' | 'contact'; counts: SegmentCounts; sample: Record<string, unknown>[]; readback: string }

/** The builder's live, debounced preview -- a definition that need not be saved yet. */
export async function previewSegmentAction(definition: unknown): Promise<{ ok: true; data: PreviewResult } | Fail> {
  try {
    const def = validateDefinition(definition)
    const compiled = await compileSegment(db(), def)
    const [counts, sample] = await Promise.all([countSegment(db(), compiled), sampleRows(db(), compiled, 10)])
    return { ok: true, data: { entity: def.entity, counts, sample, readback: readback(def) } }
  } catch (e) {
    return fail(e)
  }
}

export async function listSegmentsAction(opts: { includeArchived?: boolean; campaignId?: number | null } = {}): Promise<{ ok: true; segments: Segment[] } | Fail> {
  try {
    return { ok: true, segments: await listSegments(db(), { includeArchived: opts.includeArchived, campaignId: opts.campaignId }) }
  } catch (e) {
    return fail(e)
  }
}

export async function getSegmentAction(id: number): Promise<{ ok: true; data: Segment & { readback: string } } | Fail> {
  try {
    const seg = await getSegment(db(), id)
    if (!seg) return { ok: false, error: `No segment ${id}.` }
    return { ok: true, data: { ...seg, readback: readback(seg.definition) } }
  } catch (e) {
    return fail(e)
  }
}

export async function createSegmentAction(input: {
  name: string
  entity: 'company' | 'contact'
  definition: unknown
  description?: string | null
  campaign_id?: number | null
}): Promise<{ ok: true; data: Segment } | Fail> {
  try {
    const ME = await actorFor('editor')
    const d = db()
    const data = await d.tx((q) => createSegment(q, ME, { ...input }, 'ui'), ME)
    touch()
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

export async function createFromPresetAction(presetKey: string, campaignId: number | null): Promise<{ ok: true; data: Segment } | Fail> {
  try {
    const ME = await actorFor('editor')
    const preset = getPreset(presetKey)
    if (!preset) return { ok: false, error: `No starter template "${presetKey}".` }
    const d = db()
    const data = await d.tx(
      (q) =>
        createSegment(
          q,
          ME,
          {
            name: preset.label,
            description: preset.description,
            entity: preset.definition.entity,
            definition: preset.definition,
            campaign_id: campaignId,
            is_preset: true,
            preset_key: preset.key,
          },
          'ui',
        ),
      ME,
    )
    touch()
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

export async function updateSegmentAction(
  id: number,
  patch: { name?: string; description?: string | null; campaign_id?: number | null; definition?: unknown },
): Promise<{ ok: true; data: Segment } | Fail> {
  try {
    const ME = await actorFor('editor')
    const d = db()
    const data = await d.tx((q) => updateSegment(q, ME, id, patch, 'ui'), ME)
    touch(id)
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

export async function archiveSegmentAction(id: number): Promise<{ ok: true; data: Segment } | Fail> {
  try {
    const ME = await actorFor('editor')
    const d = db()
    const data = await d.tx((q) => archiveSegment(q, ME, id, 'ui'), ME)
    touch(id)
    return { ok: true, data }
  } catch (e) {
    return fail(e)
  }
}

/** Static list membership (2.2's "Static lists show their members with remove"). */
export async function removeStaticMemberAction(segmentId: number, entity: 'company' | 'contact', memberId: number): Promise<{ ok: true } | Fail> {
  try {
    const ME = await actorFor('editor')
    const d = db()
    const seg = await getSegment(d, segmentId)
    if (!seg) return { ok: false, error: `No segment ${segmentId}.` }
    if (seg.kind !== 'static') return { ok: false, error: 'Only a static list can have members removed by hand.' }
    await d.tx(async (q) => {
      const col = entity === 'company' ? 'company_id' : 'contact_id'
      await q.query(`delete from lp.segment_members where segment_id = $1 and ${col} = $2`, [segmentId, memberId])
      await emitLeadEvents(q, [{
        type: 'segment_left',
        company_id: entity === 'company' ? memberId : null,
        contact_id: entity === 'contact' ? memberId : null,
        source: 'ui',
        actor: ME,
        props: { segment_id: segmentId, segment_name: seg.name },
      }])
    }, ME)
    touch(segmentId)
    return { ok: true }
  } catch (e) {
    return fail(e)
  }
}

export async function segmentMembersAction(id: number, limit = 50, offset = 0): Promise<{ ok: true; data: { id: number; added_by?: string | null; source?: string | null }[] } | Fail> {
  try {
    const d = db()
    const seg = await getSegment(d, id)
    if (!seg) return { ok: false, error: `No segment ${id}.` }
    const col = seg.entity === 'company' ? 'company_id' : 'contact_id'
    if (seg.kind === 'static') {
      const { rows } = await d.query<{ id: number; added_by: string | null; source: string | null }>(
        `select ${col} as id, added_by, source from lp.segment_members where segment_id = $1 and ${col} is not null order by added_at desc limit $2 offset $3`,
        [id, Math.min(Math.max(limit, 1), 500), Math.max(offset, 0)],
      )
      return { ok: true, data: rows }
    }
    const compiled = await compileSegment(d, seg.definition)
    const rows = await matchingIds(d, compiled, { limit, offset })
    return { ok: true, data: rows.map((rid) => ({ id: rid })) }
  } catch (e) {
    return fail(e)
  }
}
