'use client'

import { useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { primaryBtnCls } from '@/components/ops/bits'
import type { ActorKindsRow } from '@/lib/settings/store'
import { taskKindOptions } from '@/lib/settings/task-kinds'

type FormAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

function AgentRow({ actor, action }: { actor: ActorKindsRow; action: FormAction }) {
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(action, null)
  const [selected, setSelected] = useState<string[]>(actor.takes_kinds)
  const options = taskKindOptions(actor.takes_kinds)
  const toggle = (k: string) => setSelected((cur) => (cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k]))
  const unchanged = selected.length === actor.takes_kinds.length && selected.every((k) => actor.takes_kinds.includes(k))
  return (
    <form action={formAction} className="border-b border-line-soft py-3 last:border-b-0">
      <input type="hidden" name="actor_id" value={actor.id} />
      {/* Same stored shape as before: a comma-joined list, blank = any kind. */}
      <input type="hidden" name="takes_kinds" value={selected.join(',')} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-ink">{actor.display_name}</span>
        <span className="text-xs text-ink-faint">{selected.length ? `${selected.length} selected` : 'Takes any kind'}</span>
      </div>
      <fieldset className="mt-2 flex flex-wrap gap-1.5" aria-label={`Task kinds ${actor.display_name} takes`}>
        {options.map((o) => {
          const on = selected.includes(o.value)
          return (
            <label
              key={o.value}
              title={o.hint}
              className={`inline-flex cursor-pointer items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs ${
                on ? 'border-accent/40 bg-accent-soft text-accent' : 'border-line bg-canvas text-ink-muted hover:text-ink'
              }`}
            >
              <input type="checkbox" className="h-3 w-3 accent-current" checked={on} onChange={() => toggle(o.value)} aria-label={`${actor.display_name}: ${o.label}`} />
              {o.label}
            </label>
          )
        })}
      </fieldset>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="submit" disabled={pending || unchanged} className={primaryBtnCls}>
          {pending ? 'Saving…' : 'Save'}
        </button>
        {selected.length ? (
          <button type="button" onClick={() => setSelected([])} className="text-xs text-ink-faint underline hover:text-ink">
            Clear (any kind)
          </button>
        ) : null}
        {state ? <Pill tone={state.ok ? 'good' : 'bad'}>{state.message}</Pill> : null}
      </div>
    </form>
  )
}

/** Which task kinds each agent picks up: tick the kinds it should take; none ticked = any kind. The action is injected, like PauseControl's. */
export function AgentsSection({ actors, action }: { actors: ActorKindsRow[]; action: FormAction }) {
  const agents = actors.filter((a) => a.kind === 'agent')
  if (!agents.length) return <p className="text-xs text-ink-faint">No agents yet.</p>
  return (
    <div>
      <p className="mb-1 text-xs leading-snug text-ink-faint">Tick the kinds of task each agent should pick up. Leave all unticked and it takes any kind.</p>
      {agents.map((a) => (
        <AgentRow key={a.id} actor={a} action={action} />
      ))}
    </div>
  )
}
