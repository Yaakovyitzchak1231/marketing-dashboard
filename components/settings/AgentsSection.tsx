'use client'

import { useActionState, useState } from 'react'
import type { FormResult } from '@/app/actions/settings'
import { Pill } from '@/components/dashboard/primitives'
import { inputCls, primaryBtnCls } from '@/components/ops/bits'
import type { ActorKindsRow } from '@/lib/settings/store'

type FormAction = (prev: FormResult | null, f: FormData) => Promise<FormResult>

function AgentRow({ actor, action }: { actor: ActorKindsRow; action: FormAction }) {
  const [state, formAction, pending] = useActionState<FormResult | null, FormData>(action, null)
  const [draft, setDraft] = useState(actor.takes_kinds.join(', '))
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2 border-b border-line-soft py-2.5 last:border-b-0">
      <input type="hidden" name="actor_id" value={actor.id} />
      <span className="w-32 shrink-0 text-[13px] font-medium text-ink">{actor.display_name}</span>
      <input
        name="takes_kinds"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        placeholder="any kind (leave blank)"
        className={`min-w-0 flex-1 ${inputCls}`}
        aria-label={`Task kinds ${actor.display_name} takes`}
      />
      <button type="submit" disabled={pending} className={primaryBtnCls}>
        {pending ? 'Saving…' : 'Save'}
      </button>
      {state ? <Pill tone={state.ok ? 'good' : 'bad'}>{state.message}</Pill> : null}
    </form>
  )
}

/** Which task kinds each agent picks up. Empty = any kind. Comma-separated for now (chips are cosmetic, not a new input shape). The action is injected, like PauseControl's. */
export function AgentsSection({ actors, action }: { actors: ActorKindsRow[]; action: FormAction }) {
  const agents = actors.filter((a) => a.kind === 'agent')
  if (!agents.length) return <p className="text-[12.5px] text-ink-faint">No agents yet.</p>
  return (
    <div>
      <p className="mb-2 text-[12px] leading-snug text-ink-faint">Comma-separated task kinds, e.g. <code className="rounded bg-canvas px-1">find_leads, verify_contacts</code>. Blank means an agent takes any kind.</p>
      {agents.map((a) => (
        <AgentRow key={a.id} actor={a} action={action} />
      ))}
    </div>
  )
}
