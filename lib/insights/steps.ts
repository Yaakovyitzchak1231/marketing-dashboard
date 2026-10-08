/**
 * Sequence rules from CampaignRow.steps (per step + A/B variant, this period):
 * A/B winners, follow-up steps that earn nothing, where in the sequence
 * replies come from, and the best subject line.
 * Step reply rate is always recomputed as replied / sent for that step+variant.
 */
import type { CampaignRow, StepStat } from '@/lib/dashboard/types'
import {
  FIRST_STEP_DOMINANT_SHARE,
  FOLLOWUPS_STRONG_SHARE,
  MIN_REPLIES_FOR_STEP_MIX,
  MIN_SENDS_FOR_SUBJECT,
  MIN_SENDS_PER_VARIANT,
  MIN_SENDS_TO_CUT_STEP,
} from './thresholds'
import { num, ofN, pct, rate, significant, twoProportionZ, wilson } from './stats'
import { RULE_IMPACT, mag, type InsightInput, type RankedInsight } from './types'
import { periodLabel, q } from './util'

/** Steps with a usable step number (data layer drops Instantly's null-step row; we guard anyway). */
function validSteps(c: CampaignRow): StepStat[] {
  return (c.steps ?? []).filter((s) => Number.isInteger(s.step) && s.step >= 1)
}

function subj(s: StepStat): string {
  return s.subject && s.subject.trim() ? `“${s.subject.trim()}”` : '(no subject: sent as a reply in the thread)'
}

function stepEntity(c: CampaignRow, step: number, variant?: string) {
  return { kind: 'step' as const, id: `${c.id}:${step}${variant ? `:${variant}` : ''}`, name: `${c.name}: step ${step}${variant ? ` variant ${variant}` : ''}` }
}

export function stepInsights(d: InsightInput): RankedInsight[] {
  const out: RankedInsight[] = []
  const period = periodLabel(d.range)
  const campaigns = [...d.campaigns].sort((a, b) => a.id.localeCompare(b.id))

  for (const c of campaigns) {
    const steps = validSteps(c)
    const byStep = new Map<number, StepStat[]>()
    for (const s of steps) byStep.set(s.step, [...(byStep.get(s.step) ?? []), s])

    for (const [step, variants] of [...byStep.entries()].sort((a, b) => a[0] - b[0])) {
      /* --- A/B: best vs worst variant with enough sends, two-proportion z-test at 95%. --- */
      const ok = variants
        .filter((v) => v.sent != null && v.sent >= MIN_SENDS_PER_VARIANT && v.replied != null && rate(v.replied, v.sent) != null)
        .sort((a, b) => a.variant.localeCompare(b.variant))
      if (ok.length >= 2) {
        const ranked = [...ok].sort((a, b) =>
          (rate(b.replied, b.sent) as number) - (rate(a.replied, a.sent) as number) || a.variant.localeCompare(b.variant))
        const win = ranked[0]
        const lose = ranked[ranked.length - 1]
        const z = twoProportionZ(win.replied, win.sent, lose.replied, lose.sent)
        if (significant(z) && (z as number) > 0) {
          const pw = rate(win.replied, win.sent) as number
          const pl = rate(lose.replied, lose.sent) as number
          out.push({
            id: `variant-winner:${c.id}:${step}`,
            severity: 'opportunity',
            title: `Make variant ${win.variant} the default for step ${step} of ${q(c.name)}`,
            detail:
              `In ${period}, variant ${win.variant} ${subj(win)} got replies from ${pct(pw)} of sends (${ofN(win.replied as number, win.sent as number)}); ` +
              `variant ${lose.variant} ${subj(lose)} got ${pct(pl)} (${ofN(lose.replied as number, lose.sent as number)}). ` +
              `The difference is bigger than chance at 95% confidence.`,
            action: `Turn off variant ${lose.variant} on step ${step} in Instantly and write a new challenger against variant ${win.variant}.`,
            metric: { label: `Step ${step} reply rate`, value: `${win.variant} ${pct(pw)} vs ${lose.variant} ${pct(pl)}` },
            entity: stepEntity(c, step, win.variant),
            impact: RULE_IMPACT.variantWinner + mag((pw - pl) * 1000),
          })
        }
      }

      /* --- Dead follow-up step: step 2+ with real volume and zero replies. --- */
      if (step >= 2 && variants.every((v) => v.sent != null && v.replied != null)) {
        const sent = variants.reduce((s, v) => s + (v.sent as number), 0)
        const replied = variants.reduce((s, v) => s + (v.replied as number), 0)
        if (sent >= MIN_SENDS_TO_CUT_STEP && replied === 0) {
          const w = wilson(0, sent)
          out.push({
            id: `step-dead:${c.id}:${step}`,
            severity: 'opportunity',
            title: `Step ${step} of ${q(c.name)} gets no replies`,
            detail: `0 replies from ${num(sent)} step-${step} sends in ${period}` + (w ? ` (true rate very likely under ${pct(w.upper)})` : '') + '.',
            action: `Cut step ${step} or rewrite it with a new angle; right now it spends sends and sender reputation for nothing.`,
            metric: { label: `Step ${step} replies`, value: `0 of ${num(sent)}` },
            entity: stepEntity(c, step),
            impact: RULE_IMPACT.deadStep + mag(sent / 100),
          })
        }
      }
    }
  }

  /* --- Where replies come from, across all campaigns. --- */
  // Shares are only honest when every row reported its replies; one unknown row would skew them, so skip.
  const allRows = campaigns.flatMap(validSteps)
  const complete = allRows.every((s) => s.replied != null)
  const perStep = new Map<number, { sent: number; replied: number }>()
  for (const c of complete ? campaigns : []) {
    for (const s of validSteps(c)) {
      if (s.replied == null) continue
      const cur = perStep.get(s.step) ?? { sent: 0, replied: 0 }
      cur.replied += s.replied
      cur.sent += s.sent ?? 0
      perStep.set(s.step, cur)
    }
  }
  const totalReplies = [...perStep.values()].reduce((s, v) => s + v.replied, 0)
  if (totalReplies >= MIN_REPLIES_FOR_STEP_MIX) {
    const rows = [...perStep.entries()].sort((a, b) => a[0] - b[0])
    const first = perStep.get(1)?.replied ?? 0
    const firstShare = first / totalReplies
    const followShare = 1 - firstShare
    const lines = rows
      .map(([step, v]) => {
        const r = rate(v.replied, v.sent)
        return `step ${step}: ${num(v.replied)} (${pct(v.replied / totalReplies)})${r != null ? `, ${pct(r)} of its ${num(v.sent)} sends` : ''}`
      })
      .join('; ')
    const dominant = firstShare >= FIRST_STEP_DOMINANT_SHARE
    const strong = followShare >= FOLLOWUPS_STRONG_SHARE
    out.push({
      id: 'step-mix',
      severity: dominant ? 'opportunity' : 'win',
      title: dominant
        ? `Step 1 earns ${pct(firstShare)} of your replies`
        : strong
          ? `Follow-ups earn ${pct(followShare)} of your replies`
          : `Step 1 earns ${pct(firstShare)} of replies, follow-ups the rest`,
      detail: `Replies by step in ${period}, all campaigns (${num(totalReplies)} total): ${lines}.`,
      action: dominant
        ? 'Put your effort into step 1: test a new subject and opener as a variant before adding more follow-ups.'
        : strong
          ? "Keep the follow-ups; they pull real weight. Don't shorten the sequence."
          : 'Keep the sequence as it is and test new step-1 variants first.',
      metric: { label: 'Step 1 share of replies', value: pct(firstShare) },
      impact: RULE_IMPACT.stepMix + mag(totalReplies / 100),
    })
  }

  /* --- Best subject line (step+variant rows with a subject and enough sends, ranked by Wilson lower bound). --- */
  const cands: { c: CampaignRow; s: StepStat; p: number; lower: number }[] = []
  for (const c of campaigns) {
    for (const s of validSteps(c)) {
      if (!s.subject || !s.subject.trim() || s.sent == null || s.sent < MIN_SENDS_FOR_SUBJECT || s.replied == null) continue
      const w = wilson(s.replied, s.sent)
      const p = rate(s.replied, s.sent)
      if (w && p != null) cands.push({ c, s, p, lower: w.lower })
    }
  }
  const distinctSubjects = new Set(cands.map((x) => x.s.subject!.trim().toLowerCase()))
  if (distinctSubjects.size >= 2) {
    cands.sort((a, b) => b.lower - a.lower || b.p - a.p || a.c.id.localeCompare(b.c.id) || a.s.step - b.s.step || a.s.variant.localeCompare(b.s.variant))
    const top = cands[0]
    if ((top.s.replied as number) > 0) {
      out.push({
        id: `subject-best:${top.c.id}:${top.s.step}:${top.s.variant}`,
        severity: 'win',
        title: `Best subject line: ${subj(top.s)}`,
        detail:
          `${pct(top.p)} of sends got a reply (${ofN(top.s.replied as number, top.s.sent as number)}) in ${period}: step ${top.s.step}, variant ${top.s.variant} of ${q(top.c.name)}. ` +
          `Ranked by the low end of its 95% range (${pct(top.lower)}) among ${cands.length} step/variant combinations with ${MIN_SENDS_FOR_SUBJECT}+ sends.`,
        action: 'Reuse this subject line\'s angle as a new variant in your active campaigns.',
        metric: { label: 'Reply rate', value: pct(top.p) },
        entity: stepEntity(top.c, top.s.step, top.s.variant),
        impact: RULE_IMPACT.bestSubject + mag(top.p * 100),
      })
    }
  }

  return out
}
