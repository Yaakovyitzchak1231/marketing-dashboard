/**
 * Per-lead preview: every step of the campaign, filled for one lead, with what's
 * missing and the copy warnings. Reads only; writes nothing.
 */
import type { Queryable } from '../db/types.ts'
import { fieldsForCampaign, getCampaign, liveVerdict, loadCampaignLeads, type CampaignRef, type LiveVerdict } from './adapter.ts'
import { copyChecks, fillTemplate, type CopyWarning, type Filled, type ValueSource } from './render.ts'
import { loadLead, resolveValues } from './resolve.ts'
import { listSteps, StepsError, type StepRow } from './store.ts'

export interface PreviewField {
  name: string
  source: string
  required: boolean
  value: string | null
  from: ValueSource | null
  real: boolean
}

export interface PreviewStep {
  step: StepRow
  subject: Filled
  body: Filled
  warnings: CopyWarning[]
}

/**
 * What the missing values would do to this lead:
 *  - ready_personalized: every required field has a real value and nothing is left unfilled
 *  - ready_generic: a required field has no real value (fallback or nothing): generic copy
 *  - parked: a placeholder would go out unfilled ({{...}} with no value and no fallback)
 * This is the copy's view only; the lead's eligibility (email, holds, rules) is the evaluator's.
 */
export type CopyOutlook = 'ready_personalized' | 'ready_generic' | 'parked'

export interface LeadPreview {
  campaign: Pick<CampaignRef, 'id' | 'name' | 'pool'>
  lead: { company_id: number; company_name: string; contact_id: number | null; email: string | null; overrides: Record<string, string> }
  fields_from: string
  fields: PreviewField[]
  steps: PreviewStep[]
  missing_required: string[]
  leftovers: string[]
  outlook: CopyOutlook
  outlook_why: string[]
  /** The rules evaluator's verdict for this lead under the campaign's rules (eligibility: email, holds, requirements). */
  verdict: LiveVerdict | null
}

export async function previewLead(q: Queryable, campaignId: number, companyId: number, now: Date = new Date()): Promise<LeadPreview> {
  const campaign = await getCampaign(q, campaignId)
  if (!campaign) throw new StepsError(`No campaign ${campaignId}.`, 404)
  const [cl] = await loadCampaignLeads(q, campaignId, { companyId })
  // A lead not on the list can still be previewed (e.g. before adding it); it just has no overrides.
  const lead = await loadLead(q, companyId, cl?.contact_id ?? null)
  if (!lead) throw new StepsError(`No lead ${companyId}.`, 404)
  const overrides = cl?.overrides ?? {}
  const { fields, from } = await fieldsForCampaign(q, campaign)
  const values = resolveValues(fields, lead, overrides, now)
  const steps = await listSteps(q, campaignId)

  const pf: PreviewField[] = fields.map((f) => ({
    name: f.name,
    source: f.source,
    required: f.required,
    value: values[f.name]?.value ?? null,
    from: values[f.name]?.source ?? null,
    real: values[f.name]?.real ?? false,
  }))
  const ps: PreviewStep[] = steps.map((s) => {
    const subject = fillTemplate(s.subject, values)
    const body = fillTemplate(s.body, values)
    const warnings = copyChecks(body.text)
    if (subject.leftovers.length) warnings.unshift({ code: 'leftover', message: `Subject has unfilled ${subject.leftovers.map((x) => `{{${x}}}`).join(', ')}` })
    for (const u of [...new Set([...subject.unknown, ...body.unknown])]) {
      warnings.push({ code: 'leftover', message: `{{${u}}} is not a personalization field of this campaign.` })
    }
    return { step: s, subject, body, warnings }
  })

  const used = new Set(ps.flatMap((p) => [...p.subject.used, ...p.body.used]).map((n) => n.toLowerCase()))
  const missing_required = pf.filter((f) => f.required && !f.real).map((f) => f.name)
  const leftovers = [...new Set(ps.flatMap((p) => [...p.subject.leftovers, ...p.body.leftovers]))]
  const why: string[] = []
  let outlook: CopyOutlook = 'ready_personalized'
  if (missing_required.length) {
    outlook = 'ready_generic'
    why.push(`No real value for required field${missing_required.length > 1 ? 's' : ''} ${missing_required.map((n) => `{{${n}}}`).join(', ')}: generic copy.`)
  }
  const fallbackUsed = pf.filter((f) => !f.real && f.value != null && used.has(f.name.toLowerCase())).map((f) => f.name)
  if (fallbackUsed.length) why.push(`Fallback text used for ${fallbackUsed.map((n) => `{{${n}}}`).join(', ')}.`)
  if (leftovers.length) {
    outlook = 'parked'
    why.push(`Would go out with ${leftovers.map((n) => `{{${n}}}`).join(', ')} unfilled: add a value, an override, or a fallback.`)
  }
  if (!steps.length) why.push('This campaign has no steps yet.')
  const verdict = await liveVerdict(q, campaign, companyId, now)

  return {
    campaign: { id: campaign.id, name: campaign.name, pool: campaign.pool },
    lead: {
      company_id: lead.company.id,
      company_name: lead.company.name,
      contact_id: lead.contact?.id ?? null,
      email: (lead.contact?.email as string | null | undefined) ?? null,
      overrides,
    },
    fields_from: from,
    fields: pf,
    steps: ps,
    missing_required,
    leftovers,
    outlook,
    outlook_why: why,
    verdict,
  }
}

/** Copy warnings for the template itself (no lead): links, length, question. Placeholders count as one word each. */
export function templateWarnings(step: Pick<StepRow, 'body'>): CopyWarning[] {
  return copyChecks(step.body).filter((w) => w.code !== 'leftover')
}
