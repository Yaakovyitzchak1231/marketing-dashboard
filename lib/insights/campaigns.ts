/**
 * Campaign-level rules: ranking (with a small-sample guard), comparison with
 * his own history (lifetime), zero-reply campaigns, and lifecycle problems
 * (error status, out of leads, low runway, finished or stopped campaigns).
 */
import type { CampaignRow } from '@/lib/dashboard/types'
import {
  LOW_RUNWAY_DAYS,
  MIN_CONTACTED_FOR_ZERO_REPLY,
  MIN_CONTACTED_TO_RANK,
} from './thresholds'
import { num, ofN, pct, rate, wilson } from './stats'
import { RULE_IMPACT, mag, type InsightInput, type RankedInsight } from './types'
import { activeInRange, campaignEntity, periodLabel, q, rangeDays } from './util'

type Metric = 'replied' | 'positive'

interface Scored {
  c: CampaignRow
  k: number
  n: number
  p: number
  lower: number
  upper: number
}

/** Score campaigns on k = counts[metric], n = counts.contacted, keeping only those with n >= MIN_CONTACTED_TO_RANK. */
export function eligibleCampaigns(campaigns: CampaignRow[], metric: Metric, source: 'range' | 'lifetime' = 'range'): Scored[] {
  const out: Scored[] = []
  for (const c of campaigns) {
    const counts = source === 'range' ? c.counts : c.lifetime?.counts
    if (!counts) continue
    const k = counts[metric]
    const n = counts.contacted
    if (k == null || n == null || n < MIN_CONTACTED_TO_RANK) continue
    const w = wilson(k, n)
    const p = rate(k, n)
    if (!w || p == null) continue
    out.push({ c, k, n, p, lower: w.lower, upper: w.upper })
  }
  return out
}

/** Best = highest Wilson lower bound (ties: higher rate, then more volume, then id). */
export function pickBest(s: Scored[]): Scored | null {
  if (!s.length) return null
  let best = s[0]
  for (let i = 1; i < s.length; i++) {
    const a = s[i]
    const b = best
    const diff = b.lower - a.lower || b.p - a.p || b.n - a.n || a.c.id.localeCompare(b.c.id)
    if (diff < 0) best = a
  }
  return best
}

/** Worst = lowest Wilson upper bound (ties: lower rate, then more volume, then id). */
export function pickWorst(s: Scored[]): Scored | null {
  if (!s.length) return null
  let worst = s[0]
  for (let i = 1; i < s.length; i++) {
    const a = s[i]
    const b = worst
    const diff = a.upper - b.upper || a.p - b.p || b.n - a.n || a.c.id.localeCompare(b.c.id)
    if (diff < 0) worst = a
  }
  return worst
}

function autoNote(c: CampaignRow, inner = false): string {
  const a = c.counts.autoReplies
  if (a == null || a <= 0) return ''
  const word = a === 1 ? 'auto-reply' : 'auto-replies'
  return inner ? `; ${num(a)} ${word} not counted` : ` (plus ${num(a)} ${word}, not counted)`
}

function tooEarlyNote(campaigns: CampaignRow[]): string {
  const early = campaigns
    .filter((c) => c.counts.contacted != null && c.counts.contacted > 0 && c.counts.contacted < MIN_CONTACTED_TO_RANK)
    .sort((a, b) => a.name.localeCompare(b.name))
  if (!early.length) return ''
  const names = early.slice(0, 4).map((c) => `${q(c.name)} (${num(c.counts.contacted as number)})`).join(', ')
  const more = early.length > 4 ? ` and ${early.length - 4} more` : ''
  return ` Too early to judge (under ${MIN_CONTACTED_TO_RANK} leads contacted): ${names}${more}.`
}

export function campaignInsights(d: InsightInput): RankedInsight[] {
  const out: RankedInsight[] = []
  const period = periodLabel(d.range)
  const campaigns = [...d.campaigns].sort((a, b) => a.id.localeCompare(b.id))
  let tooEarlyUsed = false
  const early = () => {
    if (tooEarlyUsed) return ''
    tooEarlyUsed = true
    return tooEarlyNote(campaigns)
  }

  /** Cards that depend on later rules (e.g. no "best campaign" win for a campaign flagged below history). */
  const deferred: (() => RankedInsight | null)[] = []

  const zeroReplyIds = new Set(
    campaigns
      .filter((c) => c.counts.replied === 0 && c.counts.contacted != null && c.counts.contacted >= MIN_CONTACTED_FOR_ZERO_REPLY)
      .map((c) => c.id),
  )

  /* --- 1. Rank campaigns against each other in this period. --- */
  const byReply = eligibleCampaigns(campaigns, 'replied')
  if (byReply.length >= 2) {
    const best = pickBest(byReply) as Scored
    // Worst is chosen among campaigns that got at least one reply: zero-reply campaigns have their own card.
    const worst = pickWorst(byReply.filter((x) => !zeroReplyIds.has(x.c.id))) ?? (pickWorst(byReply) as Scored)
    const separated = best.c.id !== worst.c.id && best.lower > worst.upper
    if (separated && !zeroReplyIds.has(worst.c.id)) {
      out.push({
        id: `campaign-gap:${worst.c.id}`,
        severity: 'opportunity',
        title: `${q(worst.c.name)} replies at ${pct(worst.p)}, ${q(best.c.name)} at ${pct(best.p)}`,
        detail:
          `Reply rate in ${period}: ${q(best.c.name)} ${pct(best.p)} (${ofN(best.k, best.n)} leads${autoNote(best.c, true)}) vs ${q(worst.c.name)} ${pct(worst.p)} (${ofN(worst.k, worst.n)}${autoNote(worst.c, true)}). ` +
          `The gap is bigger than chance at 95% confidence.` + early(),
        action: `Rewrite ${q(worst.c.name)}'s first email using the angle and subject of ${q(best.c.name)}, or move its remaining leads into ${q(best.c.name)}.`,
        metric: { label: 'Reply rate gap', value: `${pct(best.p)} vs ${pct(worst.p)}` },
        entity: campaignEntity(worst.c),
        impact: RULE_IMPACT.campaignGap + mag((best.p - worst.p) * 1000),
      })
    }
    if (separated) deferred.push(() => flaggedVsHistory.has(best.c.id) ? null : {
      id: `campaign-best:${best.c.id}`,
      severity: 'win',
      title: `${q(best.c.name)} is your best campaign for replies (${pct(best.p)})`,
      detail:
        `${ofN(best.k, best.n)} leads contacted in ${period} replied${autoNote(best.c)}. Ranked by the low end of its 95% range (${pct(best.lower)}), so a lucky small campaign can't beat it. ` +
        `${byReply.length} campaigns had enough volume to rank.` + early(),
      action: `Put your next batch of leads into ${q(best.c.name)} and copy its first-email angle into weaker campaigns.`,
      metric: { label: 'Reply rate', value: pct(best.p) },
      entity: campaignEntity(best.c),
      impact: RULE_IMPACT.bestCampaign + mag(best.p * 100),
    })
  }

  const byPositive = eligibleCampaigns(campaigns, 'positive')
  if (byPositive.length >= 2) {
    const best = pickBest(byPositive) as Scored
    if (best.k > 0) {
      const replied = best.c.counts.replied
      const share = rate(best.k, replied)
      out.push({
        id: `campaign-best-positive:${best.c.id}`,
        severity: 'win',
        title: `${q(best.c.name)} turns the most leads into opportunities (${pct(best.p)})`,
        detail:
          `${ofN(best.k, best.n)} leads contacted in ${period} became opportunities (marked interested in Instantly)` +
          (share != null ? `, ${pct(share)} of its ${num(replied as number)} replies` : '') +
          `. Ranked by the low end of its 95% range (${pct(best.lower)}) across ${byPositive.length} campaigns.`,
        action: `Use ${q(best.c.name)}'s offer and call to action as the template for new campaigns.`,
        metric: { label: 'Positive rate', value: pct(best.p) },
        entity: campaignEntity(best.c),
        impact: RULE_IMPACT.bestPositiveCampaign + mag(best.p * 100),
      })
    }
  }

  /* --- 2. Compare this period with his own history (needs lifetime). --- */
  const flaggedVsHistory = new Set<string>()
  if (d.range.key !== 'all') {
    const histEligible = eligibleCampaigns(campaigns, 'replied', 'lifetime')
    const histBest = pickBest(histEligible)
    if (histBest) {
      for (const cur of byReply) {
        if (zeroReplyIds.has(cur.c.id)) continue // the zero-reply card already says it
        // Benchmark: all OTHER campaigns' lifetime replies pooled (sum replied / sum contacted). Never an average of rates.
        const others = histEligible.filter((h) => h.c.id !== cur.c.id)
        const k = others.reduce((s, h) => s + h.k, 0)
        const n = others.reduce((s, h) => s + h.n, 0)
        const pooled = wilson(k, n)
        const pp = rate(k, n)
        if (!pooled || pp == null) continue
        // Only call it out when this period's rate is clearly below his own history (95% intervals don't overlap).
        if (!(cur.upper < pooled.lower)) continue
        flaggedVsHistory.add(cur.c.id)
        const ratio = cur.p > 0 ? pp / cur.p : Infinity
        const bestOther = pickBest(others)
        out.push({
          id: `campaign-vs-history:${cur.c.id}`,
          severity: ratio >= 2 ? 'warning' : 'opportunity',
          title: `${q(cur.c.name)} replies at ${pct(cur.p)}, vs ${pct(pp)} across your past campaigns`,
          detail:
            `${q(cur.c.name)} in ${period}: ${ofN(cur.k, cur.n)} leads replied${autoNote(cur.c)}. ` +
            `Your other ${others.length} campaign${others.length === 1 ? '' : 's'} all time: ${ofN(k, n)} replied (${pct(pp)}).` +
            (bestOther ? ` Best ever: ${q(bestOther.c.name)}, ${pct(bestOther.p)} (${ofN(bestOther.k, bestOther.n)}).` : '') +
            ` Different lead lists, so part of the gap may be the audience.` + early(),
          action: bestOther
            ? `Test ${q(bestOther.c.name)}'s first email (subject and opener) as a new variant in ${q(cur.c.name)}.`
            : `Test a new first email in ${q(cur.c.name)} based on your past campaigns' best performer.`,
          metric: { label: 'Reply rate', value: `${pct(cur.p)} vs ${pct(pp)}` },
          entity: campaignEntity(cur.c),
          impact: RULE_IMPACT.campaignGap - 10 + mag((pp - cur.p) * 1000),
        })
      }

      // Stopped winners: campaigns with real all-time results that sent nothing this period.
      const stopped = campaigns
        .filter((c) => !activeInRange(c) && (c.status === 'completed' || c.status === 'paused'))
        .filter((c) => (c.lifetime?.counts.replied ?? 0) > 0)
        .sort((a, b) =>
          (b.lifetime?.counts.positive ?? 0) - (a.lifetime?.counts.positive ?? 0) ||
          (b.lifetime?.counts.replied ?? 0) - (a.lifetime?.counts.replied ?? 0) ||
          a.id.localeCompare(b.id))
      if (stopped.length) {
        const sending = campaigns.filter(activeInRange).sort((a, b) => a.name.localeCompare(b.name))
        const totalPos = stopped.reduce((s, c) => s + (c.lifetime?.counts.positive ?? 0), 0)
        const totalRep = stopped.reduce((s, c) => s + (c.lifetime?.counts.replied ?? 0), 0)
        const top = stopped[0]
        const topRate = rate(top.lifetime?.counts.replied, top.lifetime?.counts.contacted)
        const list = stopped.slice(0, 4).map((c) => {
          const lc = c.lifetime!.counts
          const r = rate(lc.replied, lc.contacted)
          return `${q(c.name)} (${c.status}; ${num(lc.replied ?? 0)} replies${lc.positive != null ? `, ${num(lc.positive)} opportunities` : ''}${r != null ? `, ${pct(r)} reply rate` : ''})`
        }).join('; ')
        out.push({
          id: 'campaigns-stopped-winners',
          severity: sending.length <= 1 ? 'warning' : 'opportunity',
          title: totalPos > 0
            ? `${stopped.length} campaign${stopped.length === 1 ? '' : 's'} that produced ${num(totalPos)} opportunities ${stopped.length === 1 ? 'is' : 'are'} not sending`
            : `${stopped.length} campaign${stopped.length === 1 ? '' : 's'} with ${num(totalRep)} past replies ${stopped.length === 1 ? 'is' : 'are'} not sending`,
          detail:
            `Sent nothing in ${period}: ${list}${stopped.length > 4 ? `; and ${stopped.length - 4} more` : ''}. ` +
            (sending.length
              ? `${sending.length <= 2 ? 'Only ' : ''}${sending.length} campaign${sending.length === 1 ? ' is' : 's are'} sending now: ${sending.map((c) => q(c.name)).join(', ')}.`
              : 'No campaign sent anything in this period.'),
          action: `Relaunch ${q(top.name)}${topRate != null ? ` (${pct(topRate)} all-time reply rate)` : ''} with a fresh lead list: duplicate it in Instantly and upload new leads.`,
          entity: stopped.length === 1 ? campaignEntity(top) : undefined,
          impact: RULE_IMPACT.campaignsCompleted + 200 + mag(totalPos / 10),
        })
      }
    }
  }

  /* --- 3. Zero replies after real volume. --- */
  for (const c of campaigns) {
    const n = c.counts.contacted
    if (c.counts.replied !== 0 || n == null || n < MIN_CONTACTED_FOR_ZERO_REPLY) continue
    const w = wilson(0, n)
    out.push({
      id: `campaign-zero-replies:${c.id}`,
      severity: 'warning',
      title: `${q(c.name)} has no replies from ${num(n)} leads`,
      detail:
        `0 of ${num(n)} leads contacted in ${period} replied${autoNote(c)}` +
        (w ? `; at this volume the true reply rate is very likely under ${pct(w.upper)}` : '') +
        `. Replies can lag a few days behind a send, so a campaign that started this week may still pick up.`,
      action: `If it has been sending for more than 5 days, rewrite step 1's subject and opener and check its sending accounts' bounce rates below.`,
      metric: { label: 'Replies', value: `0 of ${num(n)}` },
      entity: campaignEntity(c),
      impact: RULE_IMPACT.campaignZeroReplies + mag(n / 50),
    })
  }

  /* --- 4. Lifecycle. --- */
  const errored = campaigns.filter((c) => c.status === 'error')
  for (const c of errored) {
    out.push({
      id: `campaign-error:${c.id}`,
      severity: 'critical',
      title: `${q(c.name)} is in an error state in Instantly`,
      detail: `Instantly reports this campaign as stopped by an error (for example unhealthy sending accounts, bounce protection, or suspension).` +
        (c.leadsRemaining != null ? ` ${num(c.leadsRemaining)} leads are still waiting to be contacted.` : ''),
      action: `Open ${q(c.name)} in Instantly, fix the issue it shows (usually reconnecting or replacing sending accounts), then resume it.`,
      entity: campaignEntity(c),
      impact: RULE_IMPACT.campaignError + mag((c.leadsRemaining ?? 0) / 100),
    })
  }

  const days = rangeDays(d.range, d.daily.length)
  for (const c of campaigns) {
    if (c.status !== 'active' || c.leadsRemaining == null) continue
    if (c.leadsRemaining === 0) {
      out.push({
        id: `campaign-out-of-leads:${c.id}`,
        severity: 'warning',
        title: `${q(c.name)} is active but has no new leads left`,
        detail:
          `0 leads left to contact` + (c.leadsTotal != null ? ` out of ${num(c.leadsTotal)}` : '') +
          `. It will only send follow-ups to leads already in the sequence, then stop.`,
        action: `Upload a new lead list to ${q(c.name)} (or a duplicate of it) so it keeps sending first emails.`,
        entity: campaignEntity(c),
        impact: RULE_IMPACT.campaignOutOfLeads + mag((c.counts.contacted ?? 0) / 100),
      })
      continue
    }
    const contacted = c.counts.contacted
    if (days == null || contacted == null || contacted <= 0) continue
    const pace = contacted / days
    const runway = c.leadsRemaining / pace
    if (runway < LOW_RUNWAY_DAYS) {
      const left = runway < 1 ? 'less than a day' : `about ${Math.round(runway)} day${Math.round(runway) === 1 ? '' : 's'}`
      out.push({
        id: `campaign-low-runway:${c.id}`,
        severity: 'opportunity',
        title: `${q(c.name)} runs out of new leads in ${left}`,
        detail: `${num(c.leadsRemaining)} new lead${c.leadsRemaining === 1 ? '' : 's'} left. It contacted ${num(contacted)} new leads in ${period}; at that average pace (${pace.toFixed(1)} a day) the list lasts ${left}.`,
        action: `Queue the next lead list for ${q(c.name)} now so sending doesn't stall.`,
        entity: campaignEntity(c),
        impact: RULE_IMPACT.campaignLowRunway + mag(LOW_RUNWAY_DAYS - runway),
      })
    }
  }

  for (const f of deferred) {
    const i = f()
    if (i) out.push(i)
  }

  // Campaigns that finished during this period (only when no lifetime-based card covered them).
  // ("finished this period" is meaningless on the all-time range)
  const finished = d.range.key === 'all' ? [] : campaigns.filter((c) => c.status === 'completed' && activeInRange(c))
  if (finished.length) {
    const list = finished.slice(0, 4).map((c) =>
      `${q(c.name)} (${num(c.counts.replied ?? 0)} replies${c.counts.positive != null ? `, ${num(c.counts.positive)} opportunities` : ''} in ${period})`).join('; ')
    out.push({
      id: 'campaigns-completed',
      severity: 'opportunity',
      title: `${finished.length} campaign${finished.length === 1 ? '' : 's'} finished ${finished.length === 1 ? 'its' : 'their'} sequence`,
      detail: `${list}${finished.length > 4 ? `; and ${finished.length - 4} more` : ''}. Completed campaigns send nothing more.`,
      action: `Relaunch the best of them with a fresh lead list, or archive ${finished.length === 1 ? 'it' : 'them'} if the offer is done.`,
      entity: finished.length === 1 ? campaignEntity(finished[0]) : undefined,
      impact: RULE_IMPACT.campaignsCompleted + mag(finished.length),
    })
  }

  // Nothing could be ranked: say so honestly instead of ranking noise.
  if (!tooEarlyUsed) {
    const note = tooEarlyNote(campaigns)
    if (note && byReply.length < 2) {
      out.push({
        id: 'campaigns-too-early',
        severity: 'opportunity',
        title: 'Too early to rank some campaigns',
        detail: note.trim() + ' Below that, two or three replies swing the rate by whole points.',
        action: 'Let them reach 100 leads contacted before changing their copy.',
        impact: RULE_IMPACT.tooEarly,
      })
    }
  }

  return out
}
