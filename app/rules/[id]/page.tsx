import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getDb } from '@/lib/db'
import { getRuleSet, listProposals, resolveFieldCatalog } from '@/lib/rules/store'
import { recomputeStatus, tierCounts, topParkReasons } from '@/lib/rules/recompute'
import { CONFIDENCES, OPS, OP_WORDS, describeRequirement, type PersonalizationField, type Requirement } from '@/lib/rules/schema'
import { changeWords } from '@/lib/rules/store'
import { STANDING_RULES } from '@/lib/rules/standing'
import { archiveRulesAction, decideProposalAction, recomputeRulesAction, saveRulesAction } from '@/app/actions/rules'
import { DbNotConnected, PageFrame, btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import { Notice, SCOPE_WORDS } from '@/components/rules/bits'
import { TD, TH } from '@/components/reports/bits'

export const dynamic = 'force-dynamic'

const small = `${inputCls} !px-2 !py-1 text-xs`
const tiny = 'rounded-control border border-line bg-surface px-1.5 py-0.5 text-xs text-ink-muted hover:border-ink-faint'

function FieldSelect({ name, value }: { name: string; value?: string }) {
  return <input name={name} defaultValue={value ?? ''} list="rule-fields" className={small} placeholder="field" aria-label="Field" />
}

function ReqRow({ r, i, n }: { r: Requirement | null; i: number | 'new'; n: number }) {
  const p = `req.${i}`
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className={TD}>
        {r ? <input type="hidden" name={`${p}.id`} value={r.id} /> : null}
        <input type="checkbox" name={`${p}.enabled`} defaultChecked={r ? r.enabled : true} aria-label="On" />
      </td>
      <td className={TD}>
        <FieldSelect name={`${p}.field`} value={r?.field} />
      </td>
      <td className={TD}>
        <select name={`${p}.op`} defaultValue={r?.op ?? 'present'} className={small} aria-label="Condition">
          {OPS.map((o) => (
            <option key={o} value={o}>
              {OP_WORDS[o]}
            </option>
          ))}
        </select>
      </td>
      <td className={TD}>
        <input name={`${p}.value`} defaultValue={Array.isArray(r?.value) ? r!.value.join(', ') : (r?.value ?? '')} className={small} placeholder="value (lists: a, b)" aria-label="Value" />
      </td>
      <td className={TD}>
        <select name={`${p}.min_confidence`} defaultValue={r?.min_confidence ?? ''} className={small} aria-label="Minimum confidence">
          <option value="">any</option>
          {CONFIDENCES.map((c) => (
            <option key={c} value={c}>
              ≥ {c}
            </option>
          ))}
        </select>
      </td>
      <td className={TD}>
        <input name={`${p}.max_age_days`} defaultValue={r?.max_age_days ?? ''} inputMode="numeric" className={`${small} w-20`} placeholder="days" aria-label="Max age in days" />
      </td>
      <td className={TD}>
        <input name={`${p}.label`} defaultValue={r?.label ?? ''} className={small} placeholder={r ? describeRequirement({ ...r, label: null }) : 'label (optional)'} aria-label="Label" />
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        {typeof i === 'number' ? (
          <span className="flex gap-1">
            <button name="intent" value={`req-up:${i}`} className={tiny} disabled={i === 0} aria-label="Move up">↑</button>
            <button name="intent" value={`req-down:${i}`} className={tiny} disabled={i === n - 1} aria-label="Move down">↓</button>
            <button name="intent" value={`req-del:${i}`} className={tiny} aria-label="Remove">Remove</button>
          </span>
        ) : (
          <span className="text-xs text-ink-faint">fill to add</span>
        )}
      </td>
    </tr>
  )
}

function FldRow({ f, i, n }: { f: PersonalizationField | null; i: number | 'new'; n: number }) {
  const p = `fld.${i}`
  return (
    <tr className="border-b border-line align-top last:border-0">
      <td className={TD}>
        {f ? <input type="hidden" name={`${p}.id`} value={f.id} /> : null}
        <input type="checkbox" name={`${p}.enabled`} defaultChecked={f ? f.enabled : true} aria-label="On" />
      </td>
      <td className={TD}>
        <input name={`${p}.name`} defaultValue={f?.name ?? ''} className={small} placeholder="mergeName" aria-label="Name" />
      </td>
      <td className={TD}>
        <FieldSelect name={`${p}.source`} value={f?.source} />
      </td>
      <td className={TD}>
        <input type="checkbox" name={`${p}.required`} defaultChecked={f?.required ?? false} aria-label="Required for Ready-personalized" />
      </td>
      <td className={TD}>
        <input name={`${p}.fallback`} defaultValue={f?.fallback ?? ''} className={small} placeholder="none" aria-label="Fallback text" />
      </td>
      <td className={TD}>
        <select name={`${p}.min_confidence`} defaultValue={f?.min_confidence ?? ''} className={small} aria-label="Minimum confidence">
          <option value="">any</option>
          {CONFIDENCES.map((c) => (
            <option key={c} value={c}>
              ≥ {c}
            </option>
          ))}
        </select>
      </td>
      <td className={TD}>
        <input name={`${p}.max_age_days`} defaultValue={f?.max_age_days ?? ''} inputMode="numeric" className={`${small} w-20`} placeholder="days" aria-label="Max age in days" />
      </td>
      <td className={`${TD} whitespace-nowrap`}>
        {typeof i === 'number' ? (
          <span className="flex gap-1">
            <button name="intent" value={`fld-up:${i}`} className={tiny} disabled={i === 0} aria-label="Move up">↑</button>
            <button name="intent" value={`fld-down:${i}`} className={tiny} disabled={i === n - 1} aria-label="Move down">↓</button>
            <button name="intent" value={`fld-del:${i}`} className={tiny} aria-label="Remove">Remove</button>
          </span>
        ) : (
          <span className="text-xs text-ink-faint">fill to add</span>
        )}
      </td>
    </tr>
  )
}

export default async function RuleSetPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const { id } = await params
  const sp = await searchParams
  const db = getDb()
  if (!db) {
    return (
      <PageFrame title="Lead rules" meta="">
        <DbNotConnected what="Lead rules" />
      </PageFrame>
    )
  }
  if (!/^\d{1,15}$/.test(id)) notFound()
  const rs = await getRuleSet(db, Number(id))
  if (!rs || rs.archived) notFound()
  const [counts, jobs, proposals, reasons, FIELD_CATALOG] = await Promise.all([tierCounts(db), recomputeStatus(db), listProposals(db, rs.id), topParkReasons(db, rs.id), resolveFieldCatalog(db)])
  const c = counts.get(rs.id)
  const j = jobs.get(rs.id)
  const applies =
    rs.scope === 'default'
      ? 'Campaigns with no pool set and no rules of their own'
      : rs.scope === 'pool'
        ? `Every campaign in this pool without its own rules, now and later`
        : rs.scope === 'campaign'
          ? rs.campaign_id
            ? `Instantly campaign ${rs.campaign_name ? `"${rs.campaign_name}" ` : ''}(${rs.campaign_id})`
            : `A dashboard campaign${rs.campaign_name ? ` ("${rs.campaign_name}")` : ''}`
          : 'Nothing directly; campaigns start from it'
  return (
    <PageFrame
      title={rs.name}
      meta={
        <>
          {SCOPE_WORDS[rs.scope]} · {applies} · version {rs.version} ·{' '}
          <Link href="/rules" className="text-accent hover:underline">
            all rules
          </Link>
        </>
      }
    >
      <Notice error={sp.error} saved={sp.saved} />
      <datalist id="rule-fields">
        {FIELD_CATALOG.map((f) => (
          <option key={f.key} value={f.key}>
            {f.label}
          </option>
        ))}
        <option value="enrichment:business_type">Fact: business type (any enrichment key works)</option>
      </datalist>

      {proposals.map((p) => (
        <Card key={p.approval_id} className="mb-4 border-warn/40 p-4">
          <p className="text-sm font-semibold text-ink">
            {p.requested_by_name ?? p.requested_by} proposed a change (#{p.approval_id}){p.status === 'approved' ? ', approved on Activity, not applied yet' : ''}
          </p>
          {p.note ? <p className="mt-0.5 text-xs text-ink-muted">“{p.note}”</p> : null}
          <ul className="mt-1 list-disc pl-5 text-xs text-ink-muted">
            {p.changes.map((ch, k) => (
              <li key={k}>{changeWords(ch)}</li>
            ))}
          </ul>
          <form action={decideProposalAction} className="mt-2 flex flex-wrap items-center gap-2">
            <input type="hidden" name="approval_id" value={p.approval_id} />
            <input type="hidden" name="rule_set_id" value={rs.id} />
            <button name="decision" value="apply" className={primaryBtnCls}>Apply</button>
            <input name="note" className={`${inputCls} max-w-xs`} placeholder="reason (if rejecting)" />
            <button name="decision" value="reject" className={btnCls}>Reject</button>
          </form>
        </Card>
      ))}

      <section className="mb-6">
        <SectionHeader
          title="Leads under these rules"
          meta={
            rs.scope === 'template'
              ? 'A template scores no leads.'
              : j && j.status !== 'done'
                ? `Re-scoring: ${j.processed.toLocaleString('en-US')}${j.total != null ? ` of ${j.total.toLocaleString('en-US')}` : ''} so far`
                : 'Stored scores; refreshed after every change'
          }
        />
        {rs.scope !== 'template' ? (
          <Card className="p-4">
            <p className="font-numeric text-sm tabular-nums text-ink">
              {c ? (
                <>
                  Ready-personalized {c.ready_personalized.toLocaleString('en-US')} · Ready-generic {c.ready_generic.toLocaleString('en-US')} · Parked{' '}
                  {c.parked.toLocaleString('en-US')}
                  {c.stale ? <span className="text-ink-faint"> · {c.stale.toLocaleString('en-US')} waiting to refresh</span> : null}
                </>
              ) : (
                <span className="text-ink-faint">Not scored yet.</span>
              )}
            </p>
            {reasons.length ? (
              <ul className="mt-2 text-xs text-ink-muted">
                {reasons.map((r) => (
                  <li key={r.rule}>
                    <span className="font-numeric tabular-nums">{r.n.toLocaleString('en-US')}</span> parked by: {r.label}
                  </li>
                ))}
              </ul>
            ) : null}
            <form action={recomputeRulesAction} className="mt-3">
              <input type="hidden" name="rule_set_id" value={rs.id} />
              <button className={btnCls}>Re-score all leads now</button>
            </form>
          </Card>
        ) : null}
      </section>

      <form action={saveRulesAction}>
        <input type="hidden" name="rule_set_id" value={rs.id} />
        <input type="hidden" name="base_version" value={rs.version} />
        <input type="hidden" name="req.count" value={rs.requirements.length} />
        <input type="hidden" name="fld.count" value={rs.fields.length} />
        <section className="mb-6">
          <label className="mb-3 block max-w-md text-xs text-ink-muted">
            Name
            <input name="name" defaultValue={rs.name} className={inputCls} required />
          </label>
          <SectionHeader title="Requirements" meta="A lead must meet every one that is on to be Ready. Checked in this order; every failure is listed as a park reason." />
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>On</th>
                  <th className={TH}>Field</th>
                  <th className={TH}>Condition</th>
                  <th className={TH}>Value</th>
                  <th className={TH}>Confidence</th>
                  <th className={TH}>Max age</th>
                  <th className={TH}>Label</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {rs.requirements.map((r, i) => (
                  <ReqRow key={r.id} r={r} i={i} n={rs.requirements.length} />
                ))}
                <ReqRow r={null} i="new" n={rs.requirements.length} />
              </tbody>
            </table>
          </Card>
        </section>

        <section className="mb-6">
          <SectionHeader
            title="Personalization fields"
            meta="Sent to Instantly as {{name}}. A lead is Ready-personalized when every required field has a real value; otherwise Ready-generic. A fallback is sent but never counts as a real value."
          />
          <Card className="overflow-x-auto">
            <table className="w-full min-w-[900px]">
              <thead className="border-b border-line">
                <tr>
                  <th className={TH}>On</th>
                  <th className={TH}>Name</th>
                  <th className={TH}>Source</th>
                  <th className={TH}>Required</th>
                  <th className={TH}>Fallback</th>
                  <th className={TH}>Confidence</th>
                  <th className={TH}>Max age</th>
                  <th className={TH}></th>
                </tr>
              </thead>
              <tbody>
                {rs.fields.map((f, i) => (
                  <FldRow key={f.id} f={f} i={i} n={rs.fields.length} />
                ))}
                <FldRow f={null} i="new" n={rs.fields.length} />
              </tbody>
            </table>
          </Card>
        </section>
        <div className="mb-8 flex items-center gap-3">
          <button name="intent" value="save" className={primaryBtnCls}>
            Save and re-score
          </button>
          <span className="text-xs text-ink-faint">Every change is logged with who made it, old → new.</span>
        </div>
      </form>

      <section className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">Fields you can use</p>
          <ul className="mt-1 space-y-0.5 text-xs text-ink-muted">
            {FIELD_CATALOG.map((f) => (
              <li key={f.key}>
                <code className="text-ink">{f.key}</code> {f.label}
                {f.options ? `: ${f.options.join(', ')}` : ''}
                {f.confidence ? ' · has confidence' : ''}
                {f.dated ? ` · age = ${f.dated}` : ''}
              </li>
            ))}
            <li>
              <code className="text-ink">enrichment:&lt;key&gt;</code> any researched fact (e.g. business_type, custom_design, owner_name) · has confidence · age = when the
              fact was last checked
            </li>
          </ul>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-semibold text-ink">Always on (standing rules)</p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-ink-muted">
            {STANDING_RULES.map((r) => (
              <li key={r.code}>{r.label}</li>
            ))}
          </ul>
          {rs.scope === 'campaign' || rs.scope === 'template' ? (
            <form action={archiveRulesAction} className="mt-4 flex items-center gap-2 border-t border-line pt-3">
              <input type="hidden" name="rule_set_id" value={rs.id} />
              <label className="text-xs text-ink-muted">
                <input type="checkbox" name="confirm" value="yes" /> {rs.scope === 'campaign' ? 'Remove these rules (the campaign goes back to its pool\u2019s)' : 'Remove this template'}
              </label>
              <button className={btnCls}>Remove</button>
            </form>
          ) : null}
        </Card>
      </section>
    </PageFrame>
  )
}
