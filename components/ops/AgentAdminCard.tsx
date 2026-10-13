import { Card, Pill, SectionHeader } from '@/components/dashboard/primitives'
import { btnCls, inputCls } from '@/components/ops/bits'

type Action = (f: FormData) => void | Promise<void>

/**
 * Owner-only settings for one agent (tracker 1.2): rename, may-send flag,
 * disable / re-enable. Rendered only for an Owner; viewers and editors see the
 * status pills on the page header instead. Disable needs a second click
 * (the <details> confirm), the same two-step shape as PauseControl.
 */
export function AgentAdminCard({
  agent,
  renameAction,
  canSendAction,
  activeAction,
}: {
  agent: { id: string; display_name: string; active: boolean; can_send: boolean }
  renameAction: Action
  canSendAction: Action
  activeAction: Action
}) {
  const a = agent
  return (
    <section aria-label="Agent settings">
      <SectionHeader title="Agent settings" meta={<span>Owner only</span>} />
      <Card className="divide-y divide-line-soft">
        <form action={renameAction} className="space-y-2 p-3">
          <input type="hidden" name="agent_id" value={a.id} />
          <label className="block text-xs font-medium text-ink-muted" htmlFor="agent-display-name">Name</label>
          <div className="flex gap-2">
            <input id="agent-display-name" name="display_name" required maxLength={80} pattern=".*\S.*" title="Give the agent a name (not just spaces)." defaultValue={a.display_name} className={inputCls} />
            <button type="submit" className={btnCls}>Rename</button>
          </div>
          <p className="text-xs text-ink-faint">The id <span className="text-ink-muted">{a.id}</span> stays the same, so keys and @mentions keep working.</p>
        </form>

        <form action={canSendAction} className="space-y-2 p-3">
          <input type="hidden" name="agent_id" value={a.id} />
          <input type="hidden" name="can_send" value={a.can_send ? 'false' : 'true'} />
          <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
            May send after approval {a.can_send ? <Pill tone="accent">On</Pill> : <Pill tone="neutral">Off</Pill>}
          </p>
          <p className="text-xs leading-snug text-ink-faint">
            A flag the agent reads back from the ops API (whoami) to know whether it should carry out approved outward sends. It approves nothing: every Instantly change still waits in Needs your OK for a person.
          </p>
          <button type="submit" className={btnCls}>{a.can_send ? 'Turn off' : 'Turn on'}</button>
        </form>

        <div className="space-y-2 p-3">
          <p className="flex items-center gap-2 text-xs font-medium text-ink-muted">
            Status {a.active ? <Pill tone="good">Enabled</Pill> : <Pill tone="bad">Disabled</Pill>}
          </p>
          <p className="text-xs leading-snug text-ink-faint">
            {a.active
              ? `Disabling refuses every request ${a.display_name} makes, with any of its keys, until you re-enable it. Its keys, tasks, claims and memory are kept.`
              : `${a.display_name}'s requests are refused. Re-enabling lets its existing keys work again.`}
          </p>
          {a.active ? (
            <details>
              <summary className={`${btnCls} inline-block cursor-pointer list-none`}>Disable {a.display_name}</summary>
              <form action={activeAction} role="group" aria-label={`Confirm: disable ${a.display_name}`} className="mt-2 flex flex-wrap items-center gap-2 rounded-control border border-bad/30 bg-bad-soft px-2.5 py-1.5">
                <input type="hidden" name="agent_id" value={a.id} />
                <input type="hidden" name="active" value="false" />
                <input type="hidden" name="confirm" value="yes" />
                <span className="text-xs text-bad">Its keys stop working right away.</span>
                <button type="submit" className={btnCls}>Yes, disable</button>
              </form>
            </details>
          ) : (
            <form action={activeAction}>
              <input type="hidden" name="agent_id" value={a.id} />
              <input type="hidden" name="active" value="true" />
              <input type="hidden" name="confirm" value="yes" />
              <button type="submit" className={btnCls}>Re-enable {a.display_name}</button>
            </form>
          )}
        </div>
      </Card>
    </section>
  )
}
