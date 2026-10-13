'use client'

import { useEffect, useState, type ReactNode } from 'react'
import { SlidersHorizontal, X } from 'lucide-react'
import { cn } from './cn'

/**
 * Filters inline on desktop; behind a "Filters" button on phones, where they
 * open as a bottom sheet. The children render ONCE (no duplicated form ids):
 * CSS moves the same node between the two presentations.
 */
export function FilterSheet({ children, activeCount = 0, title = 'Filters', className }: { children: ReactNode; activeCount?: number; title?: string; className?: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-expanded={open}
        className="inline-flex h-tap items-center gap-2 rounded-control border border-line bg-surface px-3.5 text-sm font-medium text-ink shadow-card md:hidden"
      >
        <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
        {title}
        {activeCount ? <span className="rounded-full bg-accent px-1.5 text-2xs font-semibold text-on-accent">{activeCount}</span> : null}
      </button>
      {open ? <div className="fixed inset-0 z-sheet bg-ink/25 md:hidden" onClick={() => setOpen(false)} aria-hidden="true" /> : null}
      <div
        role={open ? 'dialog' : undefined}
        aria-label={open ? title : undefined}
        className={cn(
          'md:block',
          open
            ? 'max-md:fixed max-md:inset-x-0 max-md:bottom-0 max-md:z-sheet max-md:max-h-[85dvh] max-md:overflow-y-auto max-md:rounded-t-sheet max-md:border-t max-md:border-line max-md:bg-surface max-md:px-4 max-md:pb-[calc(1rem+env(safe-area-inset-bottom))] max-md:pt-3 max-md:shadow-overlay max-md:animate-slide-in-up'
            : 'max-md:hidden',
        )}
      >
        {open ? (
          <div className="mb-3 flex items-center justify-between md:hidden">
            <p className="text-base font-semibold text-ink">{title}</p>
            <button type="button" onClick={() => setOpen(false)} className="inline-flex h-tap w-tap items-center justify-center rounded-control text-ink-muted" aria-label="Close filters">
              <X aria-hidden="true" className="h-5 w-5" />
            </button>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}
