import type { ReactNode } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

/** shadcn Badge with status tones. StatusPill adds a leading dot. */
export const badgeVariants = cva('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border font-medium leading-none', {
  variants: {
    tone: {
      good: 'border-good/25 bg-good-soft text-good',
      warn: 'border-warn/25 bg-warn-soft text-warn',
      bad: 'border-bad/25 bg-bad-soft text-bad',
      accent: 'border-accent/25 bg-accent-soft text-accent',
      neutral: 'border-line bg-surface-2 text-ink-muted',
    },
    size: { sm: 'px-2 py-[3px] text-2xs', md: 'px-2.5 py-1 text-xs' },
  },
  defaultVariants: { tone: 'neutral', size: 'sm' },
})

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>

export function Badge({ tone, size, className, children, title }: VariantProps<typeof badgeVariants> & { className?: string; children: ReactNode; title?: string }) {
  return (
    <span title={title} className={cn(badgeVariants({ tone, size }), className)}>
      {children}
    </span>
  )
}

const DOT: Record<BadgeTone, string> = { good: 'bg-good', warn: 'bg-warn', bad: 'bg-bad', accent: 'bg-accent', neutral: 'bg-ink-faint' }

export function StatusPill({ tone = 'neutral', children, title, className }: { tone?: BadgeTone; children: ReactNode; title?: string; className?: string }) {
  return (
    <Badge tone={tone} title={title} className={className}>
      <span aria-hidden="true" className={cn('h-1.5 w-1.5 rounded-full', DOT[tone])} />
      {children}
    </Badge>
  )
}
