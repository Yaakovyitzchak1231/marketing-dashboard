import { Card, EmptyNote, SectionHeader } from '@/components/dashboard/primitives'
import { shortDate } from '@/components/leads/pills'
import { BUTTON_PRIMARY } from '@/components/app/PageShell'
import { addLeadFileAction, removeLeadFileAction } from '@/app/actions/lead-files'
import type { FilesSection } from '@/lib/leads/profile'

/** Notes/Files card (plan 2.10): file LINKS on a lead (lp.files, migration 0034) --
 *  no paid storage, the url points wherever the file already lives. */
export function FilesCard({ companyId, data }: { companyId: number; data: FilesSection }) {
  if (!data.available) {
    return (
      <Card className="p-4">
        <SectionHeader title="Notes & files" />
        <EmptyNote>{data.needs_migration}</EmptyNote>
      </Card>
    )
  }
  const addAction = addLeadFileAction.bind(null, companyId)
  return (
    <Card className="p-4">
      <SectionHeader title="Notes & files" />
      {!data.rows.length ? (
        <EmptyNote>No files linked yet.</EmptyNote>
      ) : (
        <ul className="mb-3 divide-y divide-line-soft text-[13px]">
          {data.rows.map((f) => {
            const removeAction = removeLeadFileAction.bind(null, companyId, f.id)
            return (
              <li key={f.id} className="flex items-center justify-between gap-2 py-1.5">
                <div className="min-w-0">
                  <a href={f.url} target="_blank" rel="noreferrer" className="truncate text-ink hover:underline">
                    {f.name}
                  </a>
                  {f.note ? <div className="truncate text-[12px] text-ink-faint">{f.note}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[12px] text-ink-faint">{shortDate(f.created_at)}</span>
                  <form action={removeAction}>
                    <button type="submit" className="text-[12px] text-ink-faint hover:text-bad">
                      Remove
                    </button>
                  </form>
                </div>
              </li>
            )
          })}
        </ul>
      )}
      <form action={addAction} className="flex flex-wrap items-center gap-2">
        <input name="name" required placeholder="Name" className="w-32 rounded-md border border-line bg-canvas px-2 py-1 text-[12px]" />
        <input name="url" required type="url" placeholder="https://…" className="min-w-[160px] flex-1 rounded-md border border-line bg-canvas px-2 py-1 text-[12px]" />
        <input name="note" placeholder="Note (optional)" className="w-40 rounded-md border border-line bg-canvas px-2 py-1 text-[12px]" />
        <button type="submit" className={BUTTON_PRIMARY}>
          Add
        </button>
      </form>
    </Card>
  )
}
