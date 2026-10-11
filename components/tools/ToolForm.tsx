import { upsertIntegrationAction } from '@/app/actions/integrations'
import { inputCls, primaryBtnCls } from '@/components/ops/bits'
import { Card, SectionHeader } from '@/components/dashboard/primitives'
import type { Integration } from '@/lib/integrations/store'

/** Add a tool, or edit an existing one (fields prefilled when `editing` is given). */
export function ToolForm({ editing }: { editing?: Integration }) {
  return (
    <Card className="p-3">
      <SectionHeader title={editing ? `Edit ${editing.name}` : 'Add a tool'} />
      <form action={upsertIntegrationAction} className="space-y-2.5">
        {editing ? <input type="hidden" name="id" value={editing.id} /> : null}
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] text-ink-muted">
            Id (slug){editing ? null : ' — e.g. "n8n"'}
            <input name="id_new" defaultValue={editing?.id} disabled={Boolean(editing)} required={!editing} className={`${inputCls} mt-1 disabled:opacity-60`} />
          </label>
          <label className="block text-[12px] text-ink-muted">
            Name
            <input name="name" defaultValue={editing?.name} required maxLength={80} className={`${inputCls} mt-1`} />
          </label>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] text-ink-muted">
            Kind
            <input name="kind" defaultValue={editing?.kind} required placeholder="e.g. listmonk, sheet, doc" className={`${inputCls} mt-1`} />
          </label>
          <label className="block text-[12px] text-ink-muted">
            Reachable from
            <select name="reachable_from" defaultValue={editing?.reachable_from ?? 'public'} className={`${inputCls} mt-1`}>
              <option value="public">Public</option>
              <option value="tailnet">Tailnet only</option>
              <option value="localhost">Localhost only</option>
            </select>
          </label>
        </div>
        <label className="block text-[12px] text-ink-muted">
          Description
          <input name="description" defaultValue={editing?.description ?? ''} maxLength={500} className={`${inputCls} mt-1`} />
        </label>
        <label className="block text-[12px] text-ink-muted">
          Open link (what a person opens)
          <input name="url" type="url" defaultValue={editing?.url ?? ''} placeholder="https://…" className={`${inputCls} mt-1`} />
        </label>
        <label className="block text-[12px] text-ink-muted">
          API URL (what the runner calls, usually http://127.0.0.1:&lt;port&gt;)
          <input name="api_url" type="url" defaultValue={editing?.api_url ?? ''} placeholder="http://127.0.0.1:…" className={`${inputCls} mt-1`} />
        </label>
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-[12px] text-ink-muted">
            Sort
            <input name="sort" type="number" defaultValue={editing?.sort ?? 100} className={`${inputCls} mt-1`} />
          </label>
          <label className="mt-5 flex items-center gap-2 text-[12px] text-ink-muted">
            <input type="checkbox" name="active" defaultChecked={editing ? editing.active : true} className="rounded border-line" />
            Active (shown on /tools)
          </label>
        </div>
        <button type="submit" className={`${primaryBtnCls} w-full`}>
          {editing ? 'Save' : 'Add tool'}
        </button>
      </form>
    </Card>
  )
}
