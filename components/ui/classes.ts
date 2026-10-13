import { cn } from './cn'

/** Class strings shared by server and client code (no hooks here). */
export const controlClass =
  'block w-full rounded-control border border-line bg-surface px-3 py-2 text-sm text-ink shadow-[inset_0_1px_0_rgb(var(--c-shadow)/0.02)] placeholder:text-ink-faint transition-colors hover:border-ink-faint/50 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:cursor-not-allowed disabled:bg-surface-2 disabled:text-ink-faint max-md:min-h-tap'

export const labelClass = 'mb-1.5 block text-xs font-medium text-ink'
export const hintClass = 'mt-1 text-xs leading-snug text-ink-faint'

export const selectClass = cn(
  controlClass,
  'appearance-none bg-[length:16px_16px] bg-[right_0.6rem_center] bg-no-repeat pr-9',
  "bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23807a71' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M4 6l4 4 4-4'/%3E%3C/svg%3E\")]",
)

