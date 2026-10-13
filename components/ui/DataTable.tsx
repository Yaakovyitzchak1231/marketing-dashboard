'use client'

import * as React from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
} from '@tanstack/react-table'
import { ArrowDown, ArrowUp, Columns3, Search } from 'lucide-react'
import { cn } from './cn'
import { controlClass } from './classes'
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from './DropdownMenu'
import { buttonClass } from './Button'

/** Column metadata DataTable reads from `columnDef.meta`. */
export interface DataColumnMeta {
  /** Label in the column chooser and in the phone card. */
  label?: string
  /** Hidden until the user turns it on in the column chooser. */
  defaultHidden?: boolean
  /** Can't be hidden (the row's title). */
  alwaysVisible?: boolean
  align?: 'left' | 'right'
  className?: string
  /** On phones: 'title' = card heading, 'hide' = omitted, default = labelled line. */
  mobile?: 'title' | 'hide'
}

/**
 * The few real tables (TanStack Table): sensible default columns, a column
 * chooser that remembers its choice, client search and sort, row click to
 * open a detail drawer, and labelled cards under md instead of a wide grid.
 */
export function DataTable<T>({
  data,
  columns,
  storageKey,
  searchPlaceholder,
  onRowClick,
  rowKey,
  toolbar,
  empty,
  className,
  isRowSelected,
}: {
  data: T[]
  columns: ColumnDef<T, unknown>[]
  /** localStorage key for the column chooser; omit to not remember. */
  storageKey?: string
  /** Show a client-side search box over all text columns. */
  searchPlaceholder?: string
  onRowClick?: (row: T) => void
  rowKey: (row: T) => string | number
  toolbar?: React.ReactNode
  empty?: React.ReactNode
  className?: string
  isRowSelected?: (row: T) => boolean
}) {
  const initialVisibility = React.useMemo<VisibilityState>(() => {
    const v: VisibilityState = {}
    for (const c of columns) {
      const id = (c.id ?? (c as { accessorKey?: string }).accessorKey) as string | undefined
      const meta = c.meta as DataColumnMeta | undefined
      if (id && meta?.defaultHidden) v[id] = false
    }
    return v
  }, [columns])
  const [visibility, setVisibility] = React.useState<VisibilityState>(initialVisibility)
  const [sorting, setSorting] = React.useState<SortingState>([])
  const [query, setQuery] = React.useState('')

  React.useEffect(() => {
    if (!storageKey) return
    try {
      const saved = window.localStorage.getItem(`tapdash.cols.${storageKey}`)
      if (saved) setVisibility({ ...initialVisibility, ...(JSON.parse(saved) as VisibilityState) })
    } catch {
      /* private mode: defaults */
    }
  }, [storageKey, initialVisibility])
  const updateVisibility = (next: VisibilityState) => {
    setVisibility(next)
    if (storageKey) {
      try {
        window.localStorage.setItem(`tapdash.cols.${storageKey}`, JSON.stringify(next))
      } catch {
        /* ignore */
      }
    }
  }

  const table = useReactTable({
    data,
    columns,
    state: { columnVisibility: visibility, sorting, globalFilter: query },
    onColumnVisibilityChange: (u) => updateVisibility(typeof u === 'function' ? u(visibility) : u),
    onSortingChange: setSorting,
    onGlobalFilterChange: setQuery,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  })
  const rows = table.getRowModel().rows
  const hideable = table.getAllLeafColumns().filter((c) => !(c.columnDef.meta as DataColumnMeta | undefined)?.alwaysVisible)

  return (
    <div className={className}>
      {searchPlaceholder || hideable.length || toolbar ? (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {searchPlaceholder ? (
            <div className="relative min-w-[12rem] flex-1 sm:max-w-xs">
              <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className={cn(controlClass, 'pl-9')}
              />
            </div>
          ) : null}
          {toolbar}
          {hideable.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger className={cn(buttonClass({ variant: 'secondary', size: 'md' }), 'ml-auto max-md:hidden')}>
                <Columns3 aria-hidden="true" /> Columns
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuLabel>Show columns</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {hideable.map((c) => (
                  <DropdownMenuCheckboxItem key={c.id} checked={c.getIsVisible()} onCheckedChange={(v) => c.toggleVisibility(!!v)} onSelect={(e) => e.preventDefault()}>
                    {(c.columnDef.meta as DataColumnMeta | undefined)?.label ?? c.id}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      ) : null}

      <div className="overflow-hidden rounded-card border border-line bg-surface shadow-card">
        {rows.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-ink-muted">{empty ?? 'Nothing to show.'}</div>
        ) : (
          <>
            <div className="hidden overflow-x-auto md:block">
              <table data-no-cards className="w-full text-left text-sm">
                <thead className="border-b border-line bg-surface-2 text-xs text-ink-muted">
                  {table.getHeaderGroups().map((hg) => (
                    <tr key={hg.id}>
                      {hg.headers.map((h) => {
                        const meta = h.column.columnDef.meta as DataColumnMeta | undefined
                        const sorted = h.column.getIsSorted()
                        return (
                          <th
                            key={h.id}
                            scope="col"
                            aria-sort={sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined}
                            className={cn('whitespace-nowrap px-4 py-2.5 font-medium', meta?.align === 'right' && 'text-right', meta?.className)}
                          >
                            {h.isPlaceholder ? null : h.column.getCanSort() ? (
                              <button type="button" onClick={h.column.getToggleSortingHandler()} className="inline-flex items-center gap-1 hover:text-ink" data-compact>
                                {flexRender(h.column.columnDef.header, h.getContext())}
                                {sorted === 'asc' ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : sorted === 'desc' ? <ArrowDown className="h-3 w-3" aria-hidden="true" /> : null}
                              </button>
                            ) : (
                              flexRender(h.column.columnDef.header, h.getContext())
                            )}
                          </th>
                        )
                      })}
                    </tr>
                  ))}
                </thead>
                <tbody className="divide-y divide-line-soft">
                  {rows.map((r) => (
                    <tr
                      key={rowKey(r.original)}
                      onClick={onRowClick ? (e) => {
                        if ((e.target as HTMLElement).closest('a,button,input,select,textarea,label')) return
                        onRowClick(r.original)
                      } : undefined}
                      className={cn(onRowClick && 'cursor-pointer', isRowSelected?.(r.original) ? 'bg-accent-soft/60' : 'hover:bg-surface-2/60')}
                    >
                      {r.getVisibleCells().map((cell) => {
                        const meta = cell.column.columnDef.meta as DataColumnMeta | undefined
                        return (
                          <td key={cell.id} className={cn('px-4 py-2.5 align-top', meta?.align === 'right' && 'text-right tabular-nums', meta?.className)}>
                            {flexRender(cell.column.columnDef.cell, cell.getContext())}
                          </td>
                        )
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="divide-y divide-line-soft md:hidden">
              {rows.map((r) => {
                const cells = r.getVisibleCells()
                const title = cells.find((c) => (c.column.columnDef.meta as DataColumnMeta | undefined)?.mobile === 'title') ?? cells[0]
                return (
                  <li
                    key={rowKey(r.original)}
                    className={cn('px-4 py-3', isRowSelected?.(r.original) && 'bg-accent-soft/60')}
                    onClick={onRowClick ? (e) => {
                      if ((e.target as HTMLElement).closest('a,button,input,select,textarea,label')) return
                      onRowClick(r.original)
                    } : undefined}
                  >
                    <div className="text-sm font-medium text-ink">{flexRender(title.column.columnDef.cell, title.getContext())}</div>
                    <dl className="mt-1.5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
                      {cells
                        .filter((c) => c !== title && (c.column.columnDef.meta as DataColumnMeta | undefined)?.mobile !== 'hide')
                        .map((c) => (
                          <React.Fragment key={c.id}>
                            <dt className="text-ink-faint">{(c.column.columnDef.meta as DataColumnMeta | undefined)?.label ?? c.column.id}</dt>
                            <dd className="min-w-0 text-right text-ink-muted [overflow-wrap:anywhere]">{flexRender(c.column.columnDef.cell, c.getContext())}</dd>
                          </React.Fragment>
                        ))}
                    </dl>
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
