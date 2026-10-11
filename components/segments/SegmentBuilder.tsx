'use client'

/**
 * The segment builder (plan 2.2): pick field -> operator -> value, AND/OR
 * groups, Include/Exclude blocks, a campaign scope picker, a debounced live
 * reach preview + plain-English readback, a sample of matching leads, and
 * the "Describe it" AI box (2.11) that fills the builder from one sentence
 * for the person to review before saving -- the AI's output is validated
 * server-side (segmentFromTextAction) exactly like any other definition, so
 * an invalid reply surfaces as a plain error, never an applied-blind segment.
 */
import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import Link from 'next/link'
import { btnCls, inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { Notice } from '@/components/campaigns/ui'
import { ConditionGroupCard } from './ConditionGroup'
import { ReachBadge } from './ReachBadge'
import { Readback } from './Readback'
import type { ConditionGroup, SegmentDefinition, SegmentEntity } from '@/lib/segments/definition'
import type { FieldDef } from '@/lib/segments/fields'
import { addGroup, defaultFieldCondition, removeGroup, withGroups } from '@/lib/segments/builder-state'
import {
  createSegmentAction, previewSegmentAction, removeStaticMemberAction, segmentFromTextAction,
  segmentMembersAction, updateSegmentAction, type PreviewResult,
} from '@/app/actions/segments'

const DEBOUNCE_MS = 500

export interface SegmentBuilderProps {
  mode: 'new' | 'edit'
  fields: FieldDef[]
  campaigns: { id: number; name: string }[]
  aiConfigured: boolean
  initial: {
    id?: number
    name: string
    description: string
    entity: SegmentEntity
    campaignId: number | null
    definition: SegmentDefinition
    kind?: 'dynamic' | 'static'
  }
}

export function SegmentBuilder({ mode, fields, campaigns, aiConfigured, initial }: SegmentBuilderProps) {
  const [name, setName] = useState(initial.name)
  const [description, setDescription] = useState(initial.description)
  const [entity, setEntity] = useState<SegmentEntity>(initial.entity)
  const [campaignId, setCampaignId] = useState<number | null>(initial.campaignId)
  const [def, setDef] = useState<SegmentDefinition>(initial.definition)
  const [preview, setPreview] = useState<PreviewResult | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ tone: 'good' | 'bad'; text: string } | null>(null)
  const [saving, startSaveTransition] = useTransition()
  const [members, setMembers] = useState<{ id: number; added_by?: string | null; source?: string | null }[] | null>(null)

  const [aiText, setAiText] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiError, setAiError] = useState<string | null>(null)

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fieldsForEntity = useMemo(() => fields.filter((f) => f.table === entity || true), [fields, entity])

  function runPreview(nextDef: SegmentDefinition) {
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      setPreviewLoading(true)
      void previewSegmentAction(nextDef).then((r) => {
        setPreviewLoading(false)
        if (r.ok) {
          setPreview(r.data)
          setPreviewError(null)
        } else {
          setPreviewError(r.error)
        }
      })
    }, DEBOUNCE_MS)
  }

  useEffect(() => {
    runPreview(def)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [def])

  useEffect(() => {
    if (mode === 'edit' && initial.id != null && initial.kind === 'static') {
      void segmentMembersAction(initial.id).then((r) => {
        if (r.ok) setMembers(r.data)
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function updateGroups(which: 'include' | 'exclude', groups: ConditionGroup[]) {
    setDef(withGroups(def, which, groups))
  }

  function addGroupTo(which: 'include' | 'exclude') {
    const first = defaultFieldCondition(fields[0]?.key ?? '')
    updateGroups(which, addGroup(which === 'include' ? def.include : def.exclude, first))
  }

  async function handleSave() {
    setNotice(null)
    startSaveTransition(async () => {
      if (mode === 'new') {
        const r = await createSegmentAction({ name, description: description || null, entity, definition: def, campaign_id: campaignId })
        if (r.ok) {
          window.location.href = `/segments/${r.data.id}`
        } else {
          setNotice({ tone: 'bad', text: r.error })
        }
      } else if (initial.id != null) {
        const r = await updateSegmentAction(initial.id, { name, description: description || null, campaign_id: campaignId, definition: def })
        setNotice(r.ok ? { tone: 'good', text: 'Saved.' } : { tone: 'bad', text: r.error })
      }
    })
  }

  async function handleDescribeIt() {
    setAiError(null)
    setAiBusy(true)
    const r = await segmentFromTextAction(aiText)
    setAiBusy(false)
    if (!r.ok) {
      setAiError(r.error)
      return
    }
    if (!r.result.configured) {
      setAiError('Set an AI key in Settings to use this')
      return
    }
    setEntity(r.result.definition.entity)
    setDef(r.result.definition)
  }

  async function handleRemoveMember(id: number) {
    if (initial.id == null) return
    const r = await removeStaticMemberAction(initial.id, entity, id)
    if (r.ok) setMembers((prev) => (prev ?? []).filter((m) => m.id !== id))
  }

  return (
    <div className="space-y-5">
      {notice ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

      <Card className="space-y-2 p-4" data-testid="describe-it-box">
        <SectionHeader title="Describe it" meta="Type who you want in plain English; review the result before saving." />
        {!aiConfigured ? (
          <p className="text-[12.5px] text-ink-faint">Set an AI key in Settings to use this.</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <textarea
              className={`${inputCls} min-h-[44px] flex-1`}
              placeholder="e.g. contacts who opened at least twice but never replied"
              value={aiText}
              onChange={(e) => setAiText(e.target.value)}
            />
            <button type="button" className={btnCls} disabled={aiBusy || !aiText.trim()} onClick={() => void handleDescribeIt()}>
              {aiBusy ? 'Thinking…' : 'Fill the builder'}
            </button>
          </div>
        )}
        {aiError ? <p role="alert" className="text-[12px] text-bad">{aiError}</p> : null}
      </Card>

      <Card className="space-y-3 p-4">
        <div className="grid gap-2 sm:grid-cols-2">
          <label className="text-[12px] text-ink-muted">
            Name
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="text-[12px] text-ink-muted">
            Campaign scope
            <select className={inputCls} value={campaignId ?? ''} onChange={(e) => setCampaignId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">All campaigns</option>
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </label>
          <label className="text-[12px] text-ink-muted sm:col-span-2">
            Description (optional)
            <input className={inputCls} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <label className="text-[12px] text-ink-muted">
            Entity
            <select
              className={inputCls}
              value={entity}
              disabled={mode === 'edit'}
              onChange={(e) => {
                const next = e.target.value as SegmentEntity
                setEntity(next)
                setDef({ entity: next, include: [], exclude: [] })
              }}
            >
              <option value="company">Companies (leads)</option>
              <option value="contact">Contacts</option>
            </select>
          </label>
        </div>
        <ReachBadge counts={preview?.counts ?? null} loading={previewLoading} error={previewError} />
        <Readback text={preview?.readback ?? null} />
      </Card>

      <section>
        <SectionHeader title="Include" meta="Match any of these groups (OR); every condition inside a group must match (AND)." />
        <div className="space-y-2">
          {def.include.map((g, i) => (
            <ConditionGroupCard
              key={i}
              label="Group"
              group={g}
              fields={fieldsForEntity}
              onChange={(next) => updateGroups('include', def.include.map((gg, j) => (j === i ? next : gg)))}
              onRemoveGroup={() => updateGroups('include', removeGroup(def.include, i))}
            />
          ))}
          {!def.include.length ? <EmptyNote>No include conditions yet — matches everyone. Add a group to narrow it down.</EmptyNote> : null}
        </div>
        <button type="button" className={`${btnCls} mt-2`} onClick={() => addGroupTo('include')}>+ Include group</button>
      </section>

      <section>
        <SectionHeader title="Exclude" meta="Drop anyone matching any of these groups." />
        <div className="space-y-2">
          {def.exclude.map((g, i) => (
            <ConditionGroupCard
              key={i}
              label="Group"
              group={g}
              fields={fieldsForEntity}
              onChange={(next) => updateGroups('exclude', def.exclude.map((gg, j) => (j === i ? next : gg)))}
              onRemoveGroup={() => updateGroups('exclude', removeGroup(def.exclude, i))}
            />
          ))}
          {!def.exclude.length ? <EmptyNote>No exclude conditions.</EmptyNote> : null}
        </div>
        <button type="button" className={`${btnCls} mt-2`} onClick={() => addGroupTo('exclude')}>+ Exclude group</button>
      </section>

      {preview?.sample.length ? (
        <section>
          <SectionHeader title="Sample of matching leads" meta={`Showing up to ${preview.sample.length}.`} />
          <Card className="overflow-x-auto p-0">
            <table className="w-full min-w-[480px] text-[12.5px]">
              <tbody>
                {preview.sample.map((row, i) => (
                  <tr key={i} className="border-b border-line last:border-0">
                    {Object.entries(row).map(([k, v]) => (
                      <td key={k} className="px-3 py-1.5 text-ink">{v == null ? '—' : String(v)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </section>
      ) : null}

      {mode === 'edit' && initial.kind === 'static' ? (
        <section>
          <SectionHeader title="Members" meta="A static list's members, hand-picked." />
          <Card className="divide-y divide-line">
            {(members ?? []).map((m) => (
              <div key={m.id} className="flex items-center justify-between px-3 py-2 text-[12.5px]">
                <span>#{m.id}{m.source ? ` · ${m.source}` : ''}</span>
                <button type="button" className="text-[12px] text-ink-faint underline decoration-line underline-offset-2 hover:text-bad" onClick={() => void handleRemoveMember(m.id)}>
                  Remove
                </button>
              </div>
            ))}
            {!members?.length ? <EmptyNote>No members yet.</EmptyNote> : null}
          </Card>
        </section>
      ) : null}

      <div className="flex items-center gap-2">
        <button type="button" className={primaryBtnCls} disabled={saving || !name.trim()} onClick={() => void handleSave()}>
          {saving ? 'Saving…' : mode === 'new' ? 'Create segment' : 'Save changes'}
        </button>
        {mode === 'edit' ? (
          <Link href="/segments" className={btnCls}>
            Back to segments
          </Link>
        ) : null}
      </div>
    </div>
  )
}
