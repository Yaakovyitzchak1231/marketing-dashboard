/**
 * PATCH /api/leads/bulk-edit  {company_ids: number[], field: string, value: string | null, confirm: true}
 *   -> 200 {field, updated, unchanged, failed: [{id, error}], message}
 *   -> 400 {error} bad body / bad value · 403 {error} not an editor, or over the editor cap · 503 no DATABASE_URL
 * The bulk bar's "Edit field" (plan 1.3). Editors and owners only; each lead is
 * changed through updateEntity (the inline-edit path), so each change gets its
 * own audit-log row naming the signed-in person.
 */
import { NextResponse } from 'next/server'
import { actorFor } from '@/lib/auth/act'
import { authDenied } from '@/lib/auth/http'
import { currentRole } from '@/lib/auth/session'
import { getDb } from '@/lib/db'
import { RegistryError } from '@/lib/edit/registry'
import { MAX_BULK_EDIT, bulkEditSentence, bulkUpdateCompanies } from '@/lib/edit/bulk'

export const dynamic = 'force-dynamic'
// Up to 5,000 leads, each its own validated transaction: give it the same budget as the other bulk routes.
export const maxDuration = 300

export async function PATCH(req: Request) {
  let actor: string
  try {
    actor = await actorFor('editor')
  } catch (e) {
    return authDenied(e)
  }
  const role = await currentRole()
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const body = (await req.json().catch(() => null)) as { company_ids?: unknown; field?: unknown; value?: unknown } | null
  const ids = Array.isArray(body?.company_ids) ? body!.company_ids : null
  if (!ids || ids.length === 0 || ids.length > MAX_BULK_EDIT || !ids.every((x) => Number.isSafeInteger(x) && (x as number) > 0)) {
    return NextResponse.json({ error: `company_ids must be 1 to ${MAX_BULK_EDIT} positive integers.` }, { status: 400 })
  }
  // No bulk change without a confirm: the bar shows the count and only its Confirm sends confirm: true.
  if ((body as { confirm?: unknown } | null)?.confirm !== true) {
    return NextResponse.json({ error: 'Confirm the change first (confirm: true).' }, { status: 400 })
  }
  if (typeof body?.field !== 'string') return NextResponse.json({ error: 'field is required.' }, { status: 400 })
  try {
    const r = await bulkUpdateCompanies(db, actor, {
      ids: ids as number[],
      field: body.field,
      value: body.value ?? null,
      isOwner: role === 'owner',
    })
    return NextResponse.json({ ...r, message: bulkEditSentence(r) })
  } catch (e) {
    if (e instanceof RegistryError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
