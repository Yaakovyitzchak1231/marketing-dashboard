'use server'

/**
 * The /suppressions page's buttons. Always acts as 'owner' (the signed-in
 * human; middleware.ts gates server actions behind login).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { SuppressionError, addSuppression, importCsv, liftSuppression } from '@/lib/suppressions/store'

const ME = 'owner'

function db() {
  const d = getDb()
  if (!d) throw new Error('The lead database is not connected (DATABASE_URL is not set).')
  return d
}
const s = (f: FormData, k: string) => {
  const v = f.get(k)
  return typeof v === 'string' ? v.trim() : ''
}
const msg = (e: unknown) => (e instanceof SuppressionError ? e.message : null)

function back(q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/suppressions?${u.toString()}`)
}

export async function addSuppressionAction(f: FormData) {
  try {
    const campaignRaw = s(f, 'campaign_id')
    await addSuppression(db(), ME, {
      email: s(f, 'email') || null,
      domain: s(f, 'domain') || null,
      reason: s(f, 'reason'),
      campaign_id: campaignRaw ? Number(campaignRaw) : null,
      note: s(f, 'note') || null,
      expires_at: s(f, 'expires_at') || null,
      source: 'ui',
    })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/suppressions')
  back({ saved: 'Added.' })
}

export async function liftSuppressionAction(f: FormData) {
  try {
    await liftSuppression(db(), ME, { id: Number(s(f, 'id')) })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
  revalidatePath('/suppressions')
  back({ saved: 'Lifted.' })
}

export async function importSuppressionsCsvAction(f: FormData) {
  try {
    const file = f.get('csv_file')
    const pasted = s(f, 'csv_text')
    const text = file instanceof File && file.size > 0 ? await file.text() : pasted
    if (!text.trim()) back({ error: 'Paste CSV or choose a file.' })
    const reasonDefault = s(f, 'reason') || 'manual'
    const out = await importCsv(db(), ME, text, { reason: reasonDefault, source: 'import' })
    revalidatePath('/suppressions')
    back({ saved: `Imported: ${out.added} added, ${out.already} already there${out.errors.length ? `, ${out.errors.length} row(s) had an error` : ''}.` })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back({ error: m })
  }
}

