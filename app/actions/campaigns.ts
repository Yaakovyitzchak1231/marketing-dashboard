'use server'

/**
 * Campaigns workspace, from the dashboard (the signed-in human, 'owner'). The
 * same functions agents reach through /api/ops (lib/campaigns/ops.ts). A bad
 * input comes back to the page as ?error=… instead of an error screen.
 * Nothing here sends anything to Instantly.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import {
  addStatus, archiveCampaign, createCampaign, duplicateCampaign, makeOwnRules, setStatusActive,
} from '@/lib/campaigns/store'
import { addLeadsByFilter, addLeadsByIds, parseLeadPatch, removeLeads, updateCampaignLead } from '@/lib/campaigns/leads'
import { CampaignError, parseCampaignPatch, parseIds, parsePick } from '@/lib/campaigns/types'

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
const idOf = (f: FormData, k = 'campaign_id') => {
  const n = Number(s(f, k))
  if (!Number.isInteger(n) || n <= 0) throw new CampaignError('Missing campaign.')
  return n
}

function back(path: string, params: Record<string, string>): never {
  const u = new URLSearchParams(params)
  redirect(`${path}${u.size ? `?${u}` : ''}`)
}

/** Run fn; on a CampaignError go back to `path` with the message (anything else is a real error). */
async function guarded(path: string, fn: () => Promise<string | void>): Promise<never> {
  let to: string | void
  try {
    to = await fn()
  } catch (e) {
    if (e instanceof CampaignError) back(path, { error: e.message })
    throw e
  }
  revalidatePath('/campaigns')
  revalidatePath('/activity')
  redirect(to || path)
}

export async function createCampaignAction(f: FormData) {
  await guarded('/campaigns', async () => {
    const from = Number(s(f, 'from_id'))
    if (Number.isInteger(from) && from > 0) {
      const r = await duplicateCampaign(db(), ME, from, { name: s(f, 'name') || null, withLeads: s(f, 'with_leads') === 'on' })
      return `/campaigns/${r.campaign.id}`
    }
    const p = parseCampaignPatch(
      { name: s(f, 'name'), pool: s(f, 'pool') || 'jeweler', goal: s(f, 'goal') || null, ...(s(f, 'is_template') ? { is_template: true } : {}) },
      { create: true },
    )
    const c = await createCampaign(db(), ME, p as { name: string }, { via: 'dashboard' })
    return `/campaigns/${c.id}`
  })
}

export async function duplicateCampaignAction(f: FormData) {
  const id = idOf(f)
  await guarded(`/campaigns/${id}`, async () => {
    const r = await duplicateCampaign(db(), ME, id, {
      name: s(f, 'name') || null,
      withLeads: s(f, 'with_leads') !== 'no',
      asTemplate: s(f, 'as_template') === 'yes',
    })
    return `/campaigns/${r.campaign.id}`
  })
}

export async function archiveCampaignAction(f: FormData) {
  const id = idOf(f)
  const returnTo = s(f, 'return_to').startsWith('/') ? s(f, 'return_to') : `/campaigns/${id}`
  await guarded(returnTo, async () => {
    if (s(f, 'confirm') !== 'yes') throw new CampaignError('Tick the box to confirm archiving.')
    await archiveCampaign(db(), ME, id)
    revalidatePath(`/campaigns/${id}`)
  })
}

export async function addStatusAction(f: FormData) {
  await guarded('/campaigns', async () => {
    await addStatus(db(), ME, { id: s(f, 'id'), label: s(f, 'label'), is_archived: s(f, 'is_archived') === 'on' })
  })
}

export async function toggleStatusAction(f: FormData) {
  await guarded('/campaigns', async () => {
    await setStatusActive(db(), ME, s(f, 'id'), s(f, 'active') === 'yes')
  })
}

export async function addLeadsByFilterAction(f: FormData) {
  const id = idOf(f)
  await guarded(`/campaigns/${id}`, async () => {
    const pick = parsePick({
      pool: s(f, 'pool'), stage: s(f, 'stage'), contact_status: s(f, 'contact_status'), verification: s(f, 'verification'),
      state: s(f, 'state'), tag: s(f, 'tag'), q: s(f, 'q'),
    })
    if (s(f, 'confirm') !== 'yes') {
      // First press: show how many match before adding.
      const p = new URLSearchParams({ preview: '1' })
      for (const [k, v] of Object.entries(pick)) if (v) p.set(`f_${k}`, String(v))
      return `/campaigns/${id}?${p}#add`
    }
    const r = await addLeadsByFilter(db(), ME, id, pick)
    revalidatePath(`/campaigns/${id}`)
    return `/campaigns/${id}?added=${r.added}&already=${r.already}`
  })
}

export async function addLeadsByIdsAction(f: FormData) {
  const id = idOf(f)
  await guarded(`/campaigns/${id}`, async () => {
    const r = await addLeadsByIds(db(), ME, id, parseIds(s(f, 'company_ids'), 'lead ids'), 'hand')
    revalidatePath(`/campaigns/${id}`)
    return `/campaigns/${id}?added=${r.added}&already=${r.already}${r.missing.length ? `&missing=${r.missing.join(',')}` : ''}`
  })
}

export async function removeLeadsAction(f: FormData) {
  const id = idOf(f)
  await guarded(`/campaigns/${id}`, async () => {
    const ids = f.getAll('company_id').map(String)
    if (s(f, 'confirm') !== 'yes') throw new CampaignError('Tick “confirm” to remove the selected leads from this campaign.')
    const r = await removeLeads(db(), ME, id, parseIds(ids, 'selected leads'))
    revalidatePath(`/campaigns/${id}`)
    return `/campaigns/${id}?removed=${r.removed}`
  })
}

export async function updateCampaignLeadAction(f: FormData) {
  const id = idOf(f)
  const companyId = idOf(f, 'company_id')
  const ret = `/campaigns/${id}?lead=${companyId}`
  await guarded(ret, async () => {
    const patch = parseLeadPatch({
      overrides_text: s(f, 'overrides_text'),
      note: s(f, 'note') || null,
      contact_id: s(f, 'contact_id') || null,
      tags: s(f, 'tags'),
    })
    await updateCampaignLead(db(), ME, id, companyId, patch)
    revalidatePath(`/campaigns/${id}`)
    return `${ret}&saved=1`
  })
}

export async function makeOwnRulesAction(f: FormData) {
  const id = idOf(f)
  await guarded(`/campaigns/${id}`, async () => {
    await makeOwnRules(db(), ME, id)
    revalidatePath(`/campaigns/${id}`)
    return `/campaigns/${id}?saved=1`
  })
}
