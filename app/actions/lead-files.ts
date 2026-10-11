'use server'

/**
 * The lead profile's Notes/Files card (plan 2.10): add/remove a file link on
 * app/leads/[id]/page.tsx. Always acts as 'owner' (the signed-in human;
 * middleware.ts gates server actions behind login).
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { FilesError, addLeadFile, removeLeadFile } from '@/lib/leads/files'

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
const msg = (e: unknown) => (e instanceof FilesError ? e.message : null)

function back(companyId: number, q: Record<string, string>): never {
  const u = new URLSearchParams(q)
  redirect(`/leads/${companyId}?${u.toString()}`)
}

export async function addLeadFileAction(companyId: number, f: FormData) {
  try {
    await addLeadFile(db(), ME, {
      company_id: companyId,
      name: s(f, 'name'),
      url: s(f, 'url'),
      note: s(f, 'note') || null,
    })
  } catch (e) {
    const m = msg(e)
    if (!m) throw e
    back(companyId, { error: m })
  }
  revalidatePath(`/leads/${companyId}`)
  back(companyId, { saved: 'File added.' })
}

export async function removeLeadFileAction(companyId: number, fileId: number) {
  await removeLeadFile(db(), ME, fileId)
  revalidatePath(`/leads/${companyId}`)
  back(companyId, { saved: 'File removed.' })
}
