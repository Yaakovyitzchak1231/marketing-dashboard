'use server'

/**
 * Static lists (plan 2.4), from the dashboard (the signed-in human, 'owner').
 * The logic lives in lib/segments/lists.ts, which itself reuses the segment
 * engine's own create_segment / segment_add_members / segment_remove_members
 * ops -- this file is just the form -> function -> redirect plumbing.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { addCompaniesToList, removeCompanyFromList, ListsError } from '@/lib/segments/lists'

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
const ids = (f: FormData, k: string) =>
  f.getAll(k).flatMap((v) => String(v).split(/[\s,]+/)).map(Number).filter((n) => Number.isInteger(n) && n > 0)

function back(path: string, params: Record<string, string>): never {
  const u = new URLSearchParams(params)
  redirect(`${path}${u.size ? `${path.includes('?') ? '&' : '?'}${u}` : ''}`)
}

async function guarded(path: string, fn: () => Promise<string | void>): Promise<never> {
  let to: string | void
  try {
    to = await fn()
  } catch (e) {
    if (e instanceof ListsError) back(path, { error: e.message })
    throw e
  }
  revalidatePath('/leads')
  redirect(to || path)
}

/** Add one or more leads (company_id, repeatable) to an existing list (list_id) or a new one (new_list_name). */
export async function addToListAction(f: FormData) {
  const returnTo = s(f, 'return_to') || '/leads'
  await guarded(returnTo, async () => {
    const companyIds = ids(f, 'company_id')
    const listId = s(f, 'list_id') ? Number(s(f, 'list_id')) : null
    const r = await addCompaniesToList(db(), ME, { listId, newListName: s(f, 'new_list_name') || null }, companyIds)
    return `${returnTo}${returnTo.includes('?') ? '&' : '?'}listed=${r.added}&list=${encodeURIComponent(r.list.name)}`
  })
}

export async function removeFromListAction(f: FormData) {
  const returnTo = s(f, 'return_to') || '/leads'
  await guarded(returnTo, async () => {
    await removeCompanyFromList(db(), ME, Number(s(f, 'list_id')), Number(s(f, 'company_id')))
  })
}
