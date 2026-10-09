/**
 * PATCH /api/leads/:id/contacts/:contactId  {first_name?, last_name?, email?, title?, phone?, status?}
 *   -> 200 {contact, changes, verification_reset}
 *   -> 400 {error} bad value (e.g. not an email) · 404 {error} no such contact on this lead
 *      · 409 {error} that email is already another contact · 503 {error} no DATABASE_URL
 * Human route (behind the login gate); the actor is the owner. A new email is
 * re-normalized and its verification reset; held statuses are never converted.
 */
import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { CONTACT_EDIT_FIELDS, editContact, LeadEditError, parsePatch } from '@/lib/leads/edit'

export const dynamic = 'force-dynamic'

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string; contactId: string }> }) {
  const db = getDb()
  if (!db) return NextResponse.json({ error: 'The lead database is not connected (DATABASE_URL is not set).' }, { status: 503 })
  const { id, contactId } = await ctx.params
  if (!/^\d{1,15}$/.test(id) || !/^\d{1,15}$/.test(contactId)) {
    return NextResponse.json({ error: 'No such contact on this lead.' }, { status: 404 })
  }
  try {
    const patch = parsePatch(await req.json().catch(() => null), CONTACT_EDIT_FIELDS)
    const r = await editContact(db, Number(id), Number(contactId), patch, 'owner')
    return NextResponse.json({ contact: r.contact, changes: r.changes, verification_reset: r.verification_reset })
  } catch (e) {
    if (e instanceof LeadEditError) return NextResponse.json({ error: e.message }, { status: e.status })
    throw e
  }
}
