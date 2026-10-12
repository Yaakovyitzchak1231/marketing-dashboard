/**
 * One handler, two doors (same contract):
 *   people:  /api/campaign-steps/:campaignId/...      (behind the login gate, signed-in actor, editor or above;
 *                                                      /outcome needs the owner)
 *   agents:  /api/ops/campaign-steps/:campaignId/...  (ops Bearer <redacted> via opsGate, actor = the agent;
 *                                                      status changes and /outcome need owner-or-system)
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
 *   GET    /experiments                                              -> A/B experiments on this campaign's steps
 *   POST   /experiments {step_number, name, config?}                 -> {experiment}
 *   GET    /experiments/:id                                          -> {experiment, outcomes, assignments}
 *   PATCH  /experiments/:id {name?, status?, config?}                -> {experiment}
 *   POST   /experiments/:id/evaluate                                 -> auto-winner evaluation
 *   POST   /experiments/:id/assign {company_id, contact_id?}         -> the lead's variant (idempotent)
 *   POST   /experiments/:id/outcome {variant, sends?, replies?, idempotency_key?}  -> updated counters (owner-only; replies = positive replies only)
 * Every write is in the activity log with the actor and old -> new.
 */
import { NextResponse } from 'next/server'
import type { Db } from '../db/types.ts'
import { fieldsForCampaign, getCampaign, loadCampaignLeads } from './adapter.ts'
import { cancelPush, linkInstantly, listPushRequests, requestPush } from './instantly.ts'
import { previewLead, templateWarnings } from './preview.ts'
import { createStep, deleteStep, listSteps, parseStepInput, reorderSteps, StepsError, updateStep } from './store.ts'
import { actorFor } from '../auth/act.ts'
import { AuthError } from '../auth/roles.ts'
import { requireOwnerOrSystem } from '../ops/actor-role.ts'
import { OpsError } from '../ops/core.ts'
import { assignVariant } from '../experiments/assign.ts'
import {
  createExperiment,
  ExperimentsError,
  getExperimentDetail,
  listExperiments,
  recordOutcome,
  updateExperiment,
} from '../experiments/store.ts'
import { evaluateExperiment } from '../experiments/winner.ts'

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

async function handleExperiments(
  db: Db,
  actor: string,
  campaignId: number,
  method: string,
  id: string | undefined,
  sub: string | undefined,
  body: () => Promise<Record<string, unknown> | null>,
  door: 'human' | 'ops',
): Promise<NextResponse | null> {
  if (id === undefined) {
    if (method === 'GET') return json({ ok: true, experiments: await listExperiments(db, campaignId) })
    if (method === 'POST') {
      const bd = (await body()) ?? {}
      const exp = await createExperiment(db, actor, {
        campaign_id: campaignId,
        step_number: bd.step_number,
        name: bd.name,
        config: bd.config,
      } as { campaign_id: number; step_number: number; name: string; config?: unknown })
      return json({ ok: true, experiment: exp }, 201)
    }
    return null
  }
  const expId = posInt(id)
  if (!expId) return json({ ok: false, error: 'Bad experiment id.' }, 400)
  if (sub === undefined) {
    if (method === 'GET') {
      const detail = await getExperimentDetail(db, expId)
      if (!detail || detail.campaign_id !== campaignId) return json({ ok: false, error: `No experiment ${expId} on this campaign.` }, 404)
      return json({ ok: true, ...detail })
    }
    if (method === 'PATCH') {
      const bd = (await body()) ?? {}
      // Campaign check BEFORE any mutation: a mismatched id must not write.
      const detail = await getExperimentDetail(db, expId)
      if (!detail || detail.campaign_id !== campaignId) return json({ ok: false, error: `No experiment ${expId} on this campaign.` }, 404)
      if (door === 'ops' && bd.status !== undefined) {
        await requireOwnerOrSystem(db, actor, 'Changing an experiment status needs the owner (or the system runner).')
      }
      const exp = await updateExperiment(db, actor, expId, {
        name: bd.name as string | undefined,
        status: bd.status as 'draft' | 'running' | 'paused' | undefined,
        config: bd.config,
      })
      return json({ ok: true, experiment: exp })
    }
    return null
  }
  if (sub === 'evaluate' && method === 'POST') {
    const detail = await getExperimentDetail(db, expId)
    if (!detail || detail.campaign_id !== campaignId) return json({ ok: false, error: `No experiment ${expId} on this campaign.` }, 404)
    return json({ ok: true, ...(await evaluateExperiment(db, actor, expId)) })
  }
  if (sub === 'assign' && method === 'POST') {
    const bd = (await body()) ?? {}
    const detail = await getExperimentDetail(db, expId)
    if (!detail || detail.campaign_id !== campaignId) return json({ ok: false, error: `No experiment ${expId} on this campaign.` }, 404)
    const companyId = posInt(bd.company_id)
    if (!companyId) return json({ ok: false, error: 'Body needs {company_id, contact_id?}.' }, 400)
    const contactId = bd.contact_id == null ? null : posInt(bd.contact_id)
    if (bd.contact_id != null && !contactId) return json({ ok: false, error: 'contact_id must be a positive integer.' }, 400)
    return json({ ok: true, assignment: await assignVariant(db, expId, companyId, contactId) })
  }
  if (sub === 'outcome' && method === 'POST') {
    const bd = (await body()) ?? {}
    const detail = await getExperimentDetail(db, expId)
    if (!detail || detail.campaign_id !== campaignId) return json({ ok: false, error: `No experiment ${expId} on this campaign.` }, 404)
    if (typeof bd.variant !== 'string' || !bd.variant) return json({ ok: false, error: 'Body needs {variant, sends?, replies?}.' }, 400)
    // Owner-only: the human door needs the signed-in owner (not just editor);
    // the ops door needs owner-or-system. The posting actor is logged with the delta.
    const outcomeActor = door === 'human' ? await actorFor('owner') : actor
    if (door === 'ops') {
      await requireOwnerOrSystem(db, actor, 'Posting experiment outcomes needs the owner (or the system runner).')
    }
    return json({
      ok: true,
      outcome: await recordOutcome(db, outcomeActor, expId, bd.variant, {
        sends: bd.sends as number | undefined,
        // Positive replies only: auto-replies, unsubscribes, and negative
        // replies must not be posted here (they would count as wins).
        replies: bd.replies as number | undefined,
        idempotency_key: typeof bd.idempotency_key === 'string' ? bd.idempotency_key : undefined,
      }),
    })
  }
  return null
}

export async function handleCampaignSteps(
  req: Request,
  db: Db,
  actor: string,
  campaignIdRaw: string,
  path: string[],
  door: 'human' | 'ops',
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
    if (path.length >= 1 && a === 'experiments') {
      const r = await handleExperiments(db, actor, campaignId, method, b, c, body as () => Promise<Record<string, unknown> | null>, door)
      if (r) return r
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
    if (e instanceof StepsError || e instanceof ExperimentsError || e instanceof OpsError) {
      return json({ ok: false, error: e.message }, e.status)
    }
    if (e instanceof AuthError) return json({ ok: false, error: 'Not allowed for your role.' }, 403)
    throw e
  }
}
