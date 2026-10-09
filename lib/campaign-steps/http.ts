/**
 * One handler, two doors (same contract):
 *   people:  /api/campaign-steps/:campaignId/...      (behind the login gate, actor 'owner')
 *   agents:  /api/ops/campaign-steps/:campaignId/...  (ops bearer token via opsGate, actor = the agent)
 *
 *   GET    /                         -> {campaign, steps (each with copy warnings), fields, push_requests}
 *   POST   /            {subject, body, delay_days?, variant?, step_number?}  -> {step}
 *   PATCH  /:stepId     {any of those}                                       -> {step, changes}
 *   DELETE /:stepId                                                           -> {deleted}
 *   POST   /reorder     {order: [current step numbers in new order]}         -> {steps}
 *   GET    /leads                    -> the campaign's leads (for the preview picker)
 *   GET    /preview?lead=<companyId> -> every step filled for that lead, missing fields, warnings
 *   PUT    /instantly   {instantly_campaign_id: "<uuid or Instantly link>" | null}  (people only)
 *   POST   /instantly/push {what?: steps|leads|steps_and_leads, note?}  -> pending request; NOTHING is sent
 *   POST   /instantly/requests/:id/cancel
 * Every write is in the activity log with the actor and old -> new.
 */
import { NextResponse } from 'next/server'
import type { Db } from '../db/types.ts'
import { fieldsForCampaign, getCampaign, loadCampaignLeads } from './adapter.ts'
import { cancelPush, linkInstantly, listPushRequests, requestPush } from './instantly.ts'
import { previewLead, templateWarnings } from './preview.ts'
import { createStep, deleteStep, listSteps, parseStepInput, reorderSteps, StepsError, updateStep } from './store.ts'

const NO_STORE = { 'Cache-Control': 'no-store' }
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: NO_STORE })
const posInt = (v: unknown) => {
  const s = String(v ?? '')
  return /^\d{1,15}$/.test(s) && Number(s) > 0 ? Number(s) : null
}

export async function stepsOverview(db: Db, campaignId: number) {
  const campaign = await getCampaign(db, campaignId)
  if (!campaign) throw new StepsError(`No campaign ${campaignId}.`, 404)
  const [steps, f, push_requests] = await Promise.all([listSteps(db, campaignId), fieldsForCampaign(db, campaign), listPushRequests(db, campaignId)])
  return {
    campaign,
    steps: steps.map((s) => ({ ...s, warnings: templateWarnings(s) })),
    fields: f.fields,
    fields_from: f.from,
    push_requests,
  }
}

export async function handleCampaignSteps(
  req: Request,
  db: Db,
  actor: string,
  campaignIdRaw: string,
  path: string[],
): Promise<NextResponse> {
  const campaignId = posInt(campaignIdRaw)
  if (!campaignId) return json({ ok: false, error: 'No campaign with that id.' }, 404)
  const method = req.method.toUpperCase()
  const body = async () => (method === 'GET' || method === 'DELETE' ? {} : await req.json().catch(() => null))
  try {
    const [a, b, c, d] = path
    if (path.length === 0) {
      if (method === 'GET') return json({ ok: true, ...(await stepsOverview(db, campaignId)) })
      if (method === 'POST') return json({ ok: true, step: await createStep(db, actor, campaignId, parseStepInput(await body(), { partial: false })) }, 201)
    }
    if (path.length === 1 && a === 'reorder' && method === 'POST') {
      const bd = (await body()) as { order?: unknown } | null
      return json({ ok: true, steps: await reorderSteps(db, actor, campaignId, bd?.order) })
    }
    if (path.length === 1 && a === 'leads' && method === 'GET') return json({ ok: true, leads: await loadCampaignLeads(db, campaignId) })
    if (path.length === 1 && a === 'preview' && method === 'GET') {
      const lead = posInt(new URL(req.url).searchParams.get('lead'))
      if (!lead) return json({ ok: false, error: 'Pick a lead: ?lead=<lead id>.' }, 400)
      return json({ ok: true, preview: await previewLead(db, campaignId, lead) })
    }
    if (path.length === 1 && a === 'instantly' && method === 'PUT') {
      const bd = (await body()) as { instantly_campaign_id?: unknown } | null
      if (!bd || !('instantly_campaign_id' in bd)) return json({ ok: false, error: 'Body must be JSON: {"instantly_campaign_id": "<id>" | null}' }, 400)
      return json({ ok: true, ...(await linkInstantly(db, actor, campaignId, bd.instantly_campaign_id)) })
    }
    if (path.length === 2 && a === 'instantly' && b === 'push' && method === 'POST') {
      const bd = ((await body()) ?? {}) as { what?: unknown; note?: unknown }
      return json({ ok: true, request: await requestPush(db, actor, campaignId, bd), sent_to_instantly: false }, 202)
    }
    if (path.length === 4 && a === 'instantly' && b === 'requests' && d === 'cancel' && method === 'POST') {
      const rid = posInt(c)
      if (!rid) return json({ ok: false, error: 'No request with that id.' }, 404)
      return json({ ok: true, request: await cancelPush(db, actor, campaignId, rid) })
    }
    if (path.length === 1 && posInt(a)) {
      const stepId = posInt(a) as number
      if (method === 'PATCH') return json({ ok: true, ...(await updateStep(db, actor, campaignId, stepId, parseStepInput(await body(), { partial: true }))) })
      if (method === 'DELETE') return json({ ok: true, ...(await deleteStep(db, actor, campaignId, stepId)) })
    }
    return json({ ok: false, error: `No route for ${method} ${['', ...path].join('/') || '/'}. See the comment at the top of lib/campaign-steps/http.ts.` }, 404)
  } catch (e) {
    if (e instanceof StepsError) return json({ ok: false, error: e.message }, e.status)
    throw e
  }
}
