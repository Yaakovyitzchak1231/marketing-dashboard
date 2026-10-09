'use server'

/**
 * Server actions behind the Reports screens and the Instantly action buttons.
 * They run as the signed-in human ('owner') behind the login gate. Every
 * Instantly change here needs his explicit confirm click in the UI; agents
 * cannot reach these. Agents only queue Instantly changes through /api/ops
 * (instantly_* ops -> lib/instantly/gate.ts), which run after a human approves.
 */
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getDb } from '@/lib/db'
import { createTask } from '@/lib/ops/core'
import { kickDelivery } from '@/lib/notify/kick'
import { logEvent } from '@/lib/ops/events'
import { saveCampaignMeta } from '@/lib/reports/meta'
import { deleteCost, upsertCost } from '@/lib/reports/costs'
import { writerFromEnv } from '@/lib/instantly/writer'
import { campaignSwitch, confirmAddLeads, buildAddPreview, savePreview } from '@/lib/instantly/add-leads'
import { clientFromEnv, clearInstantlyMemo } from '@/lib/instantly/client'
import { listLeadsByEmail } from '@/lib/instantly/endpoints'
import { finishExport, startExport } from '@/lib/export/lead-master'
import { DEFAULT_EXPORT_TAB, tokenFromEnv, writeExportTab } from '@/lib/export/sheets'

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
const back = (f: FormData, fallback: string) => {
  const b = s(f, 'return_to')
  return b && b.startsWith('/') && !b.startsWith('//') ? b : fallback
}
function withNote(path: string, tone: 'good' | 'bad', text: string): string {
  const u = new URL(path, 'http://x')
  u.searchParams.set('note', text.slice(0, 300))
  u.searchParams.set('tone', tone)
  return `${u.pathname}?${u.searchParams.toString()}`
}

// ------------------------------------------------------------ campaign meta / costs

export async function saveCampaignMetaAction(f: FormData) {
  await saveCampaignMeta(db(), ME, {
    campaign_id: s(f, 'campaign_id'),
    campaign_name: s(f, 'campaign_name') || null,
    segment: s(f, 'segment') || null,
    angle: s(f, 'angle') || null,
  })
  revalidatePath('/reports', 'layout')
  redirect(back(f, '/reports/costs'))
}

export async function addCostAction(f: FormData) {
  const to = back(f, '/reports/costs')
  try {
    await upsertCost(db(), ME, {
      month: s(f, 'month'),
      category: s(f, 'category'),
      label: s(f, 'label'),
      amount_usd: Number(s(f, 'amount_usd').replace(/[$,]/g, '')),
      campaign_id: s(f, 'campaign_id') || null,
      notes: s(f, 'notes') || null,
    })
  } catch (e) {
    redirect(withNote(to, 'bad', (e as Error).message))
  }
  revalidatePath('/reports', 'layout')
  redirect(withNote(to, 'good', 'Cost saved.'))
}

export async function deleteCostAction(f: FormData) {
  const id = Number(s(f, 'id'))
  if (Number.isInteger(id) && id > 0) await deleteCost(db(), id)
  revalidatePath('/reports', 'layout')
  redirect(back(f, '/reports/costs'))
}

// ------------------------------------------------------------ Instantly actions (his click + confirm)

export async function campaignSwitchAction(f: FormData) {
  const to = back(f, '/reports/runway')
  const kind = s(f, 'kind') === 'resume' ? 'resume' : 'pause'
  if (s(f, 'confirm') !== 'yes') redirect(withNote(to, 'bad', 'Not confirmed; nothing changed.'))
  const writer = writerFromEnv()
  if (!writer) redirect(withNote(to, 'bad', 'Instantly actions are off on this deploy (no key, or INSTANTLY_ACTIONS=off).'))
  const r = await campaignSwitch(db(), writer!, ME, { kind, campaign_id: s(f, 'campaign_id'), campaign_name: s(f, 'campaign_name') || null })
  clearInstantlyMemo()
  revalidatePath('/reports', 'layout')
  revalidatePath('/campaigns/performance')
  redirect(withNote(to, r.ok ? 'good' : 'bad', r.message))
}

export async function previewAddLeadsAction(f: FormData) {
  const companyIds = s(f, 'company_ids')
    .split(',')
    .map((x) => Number(x))
    .filter((n) => Number.isInteger(n) && n > 0)
  const campaignId = s(f, 'campaign_id')
  if (!campaignId) redirect(withNote(`/leads/instantly?companies=${companyIds.join(',')}`, 'bad', 'Pick a campaign first.'))
  const reader = clientFromEnv()
  const lookup = reader ? async (emails: string[]) => (await listLeadsByEmail(reader, emails)).map((l) => String(l.email ?? '')).filter(Boolean) : null
  let campaignName: string | null = s(f, 'campaign_name') || null
  try {
    const names = JSON.parse(s(f, 'campaign_names') || '{}') as Record<string, unknown>
    if (typeof names[campaignId] === 'string') campaignName = names[campaignId] as string
  } catch {
    /* name is cosmetic */
  }
  const batch = s(f, 'batch') === 'role-inbox' ? 'role-inbox' : 'standard'
  const preview = await buildAddPreview(db(), { campaign_id: campaignId, campaign_name: campaignName, company_ids: companyIds, batch }, lookup)
  const row = await savePreview(db(), ME, preview)
  redirect(`/leads/instantly?action=${row.id}`)
}

export async function confirmAddLeadsAction(f: FormData) {
  const id = Number(s(f, 'action_id'))
  const to = `/leads/instantly?action=${id}`
  if (s(f, 'confirm') !== 'yes') redirect(withNote(to, 'bad', 'Not confirmed; nothing was sent.'))
  const writer = writerFromEnv()
  if (!writer) redirect(withNote(to, 'bad', 'Instantly actions are off on this deploy (no key, or INSTANTLY_ACTIONS=off).'))
  const r = await confirmAddLeads(db(), writer!, id, ME)
  clearInstantlyMemo()
  revalidatePath('/leads')
  revalidatePath('/reports', 'layout')
  redirect(withNote(to, r.action.status === 'done' ? 'good' : 'bad', r.message))
}

// ------------------------------------------------------------ weekly: assign follow-up

export async function assignFollowUpAction(f: FormData) {
  const to = back(f, '/reports/weekly')
  const agent = s(f, 'assigned_to')
  const title = s(f, 'title')
  if (!agent || !title) redirect(withNote(to, 'bad', 'Pick who should follow up.'))
  const t = await createTask(db(), ME, {
    kind: 'general',
    title: `Follow up: ${title}`.slice(0, 300),
    assigned_to: agent,
    body: [s(f, 'detail'), s(f, 'href') ? `From the weekly one-pager. Where: ${s(f, 'href')}` : 'From the weekly one-pager.'].filter(Boolean).join('\n'),
    payload: { source: 'weekly_report', item: s(f, 'item_id') },
    dedupe_key: s(f, 'item_id') ? `weekly:${s(f, 'item_id')}`.slice(0, 200) : null,
  }).catch((e: Error) => {
    if (/already exists/.test(e.message)) return null
    throw e
  })
  if (t) kickDelivery(db())
  revalidatePath('/team')
  revalidatePath('/reports/weekly')
  redirect(withNote(to, 'good', t ? `Assigned to ${agent} (task #${t.id}).` : 'That follow-up is already on the board.'))
}

// ------------------------------------------------------------ Lead Master copy

export async function runSheetExportAction() {
  const to = '/reports'
  const sheetId = process.env.LEAD_MASTER_SHEET_ID?.trim()
  const token = await tokenFromEnv(process.env).catch(() => null)
  if (!sheetId || !token) redirect(withNote(to, 'bad', 'Set LEAD_MASTER_SHEET_ID and GOOGLE_SERVICE_ACCOUNT_JSON to write the Sheet copy.'))
  const tab = process.env.LEAD_MASTER_EXPORT_TAB?.trim() || DEFAULT_EXPORT_TAB
  const d = db()
  const id = await startExport(d, ME, 'sheet', `${sheetId} / ${tab}`)
  let msg: string
  let tone: 'good' | 'bad' = 'good'
  try {
    const r = await writeExportTab(d, { sheetId: sheetId!, tab, token: token!, stamp: new Date().toISOString() })
    await finishExport(d, id, r.rows, null)
    await logEvent(d, { actor: ME, kind: 'export.lead_master', summary: `Wrote the read-only Lead Master copy: ${r.rows} rows to tab "${r.tab}"` })
    msg = `Wrote ${r.rows.toLocaleString('en-US')} rows to the "${r.tab}" tab.`
  } catch (e) {
    await finishExport(d, id, null, (e as Error).message)
    msg = (e as Error).message
    tone = 'bad'
  }
  revalidatePath('/reports')
  redirect(withNote(to, tone, msg))
}
