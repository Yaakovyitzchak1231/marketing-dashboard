import { NextRequest, NextResponse } from 'next/server'
import { getRequestClient } from '@/lib/request-client'
import { auditStamp, changeMessageFrom, recordRevision } from '@/lib/revisions'

/**
 * Costs: manual spend entry. Amounts are stored in the currency given;
 * the dashboard converts only when an explicit rate is supplied.
 * GET lists (optional ?idea_id= / ?campaign_id=), POST creates.
 */

export async function GET(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  const { searchParams } = new URL(request.url)
  // Costs have no idea_id/campaign_id columns and no FK to ideas, so the
  // join and both filters are dropped. entity_ref is the schema's free-text
  // pointer to whatever the spend was for.
  const query = supabase
    .from('costs')
    .select('id, cost_date, category, entity_ref, amount_usd, notes, created_at, revision_id, revision_number, change_kind, change_message, actor')
    .order('cost_date', { ascending: false })
    .limit(500)
  const { data, error } = await query
  if (error) {
    console.error(`costs: query failed (${error.code}): ${error.message}`)
    return NextResponse.json({ error: 'Failed to fetch costs' }, { status: 500 })
  }
  const rows = ((data ?? []) as Record<string, unknown>[]).map(row => ({
    ...row,
    // The UI reads spent_at; the schema calls it cost_date.
    spent_at: row.cost_date ?? null,
  }))
  return NextResponse.json(rows)
}

export async function POST(request: NextRequest) {
  const supabase = await getRequestClient(request)
  if (!supabase) {
    return NextResponse.json({ error: 'Supabase is not configured' }, { status: 503 })
  }
  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  const amount = Number(body.amount_usd)
  if (!Number.isFinite(amount) || amount < 0) {
    return NextResponse.json({ error: 'amount_usd must be a non-negative number' }, { status: 400 })
  }
  // Writes follow 002_unified_model.sql: cost_date (not spent_at), amount_usd,
  // and a category constrained to
  // ('domain','inbox','verification','tool','list'). An unrecognised category
  // is refused rather than defaulted, because guessing a category would
  // misreport where the money went.
  const CATEGORIES = ['domain', 'inbox', 'verification', 'tool', 'list'] as const
  type Category = (typeof CATEGORIES)[number]
  const requested = typeof body.category === 'string' ? body.category : null
  if (requested === null || !CATEGORIES.includes(requested as Category)) {
    return NextResponse.json(
      { error: `category must be one of: ${CATEGORIES.join(', ')}` },
      { status: 400 },
    )
  }
  const stamp = await auditStamp(supabase, request, {
    artifactType: 'costs',
    artifactId: null,
    changeKind: 'create',
    changeMessage: changeMessageFrom(body),
  })
  const row = {
    amount_usd: amount,
    category: requested,
    // entity_ref is the schema's free-text link to what the spend served;
    // there are no idea_id / campaign_id columns to store instead.
    entity_ref: typeof body.entity_ref === 'string' ? body.entity_ref : null,
    cost_date:
      typeof body.spent_at === 'string'
        ? body.spent_at
        : typeof body.cost_date === 'string'
          ? body.cost_date
          : new Date().toISOString().split('T')[0],
    notes: typeof body.notes === 'string' ? body.notes : null,
    ...stamp,
  }
  const { data, error } = await supabase
    .from('costs')
    .insert(row)
    .select()
    .single()
  if (error) {
    return NextResponse.json({ error: 'Failed to record cost' }, { status: 500 })
  }
  const createdId = (data as { id?: string } | null)?.id
  if (!createdId) {
    return NextResponse.json({ error: 'Failed to record cost' }, { status: 500 })
  }
  const recorded = await recordRevision(supabase, {
    revision_id: stamp.revision_id,
    artifact_type: 'costs',
    artifact_id: createdId,
    revision_number: stamp.revision_number,
    actor: stamp.actor,
    change_kind: stamp.change_kind,
    change_message: stamp.change_message,
  })
  if ('error' in recorded) {
    console.error(`costs POST revision: ${recorded.error}`)
    return NextResponse.json({ error: 'Failed to record revision' }, { status: 500 })
  }
  return NextResponse.json(data, { status: 201 })
}
