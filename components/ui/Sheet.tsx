'use client'

import * as React from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from './cn'

/** shadcn Sheet (Radix Dialog). Right side on desktop; `side="bottom"` or full screen on phones. */
export const Sheet = DialogPrimitive.Root
export const SheetTrigger = DialogPrimitive.Trigger
export const SheetClose = DialogPrimitive.Close

const SIDE = {
  right: 'inset-y-0 right-0 h-full w-full border-l sm:max-w-[440px] animate-slide-in-right',
  left: 'inset-y-0 left-0 h-full w-[86vw] max-w-[320px] border-r animate-fade-in',
  bottom: 'inset-x-0 bottom-0 max-h-[88dvh] rounded-t-sheet border-t animate-slide-in-up',
  full: 'inset-0 h-full w-full sm:inset-y-0 sm:left-auto sm:right-0 sm:max-w-[480px] sm:border-l animate-slide-in-right',
} as const

export const SheetContent = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Content>,
  Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> & { side?: keyof typeof SIDE; title: React.ReactNode; description?: React.ReactNode; hideTitle?: boolean; footer?: React.ReactNode }
>(function SheetContent({ side = 'right', className, children, title, description, hideTitle, footer, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-sheet bg-ink/25 backdrop-blur-[1px] animate-fade-in" />
      <DialogPrimitive.Content
        ref={ref}
        className={cn('fixed z-sheet flex flex-col border-line bg-surface shadow-overlay focus:outline-none', SIDE[side], className)}
        {...props}
      >
        <div className={cn('flex items-start justify-between gap-3 border-b border-line-soft px-5 py-4', hideTitle && 'sr-only')}>
          <div className="min-w-0">
            <DialogPrimitive.Title className="text-base font-semibold text-ink">{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description className="mt-0.5 text-xs text-ink-muted">{description}</DialogPrimitive.Description> : null}
          </div>
          <DialogPrimitive.Close className="-mr-2 -mt-1 inline-flex h-9 w-9 items-center justify-center rounded-control text-ink-muted hover:bg-surface-2 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40">
            <X className="h-4 w-4" aria-hidden="true" />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
        {footer ? <div className="border-t border-line-soft px-5 py-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{footer}</div> : null}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
})

/** Shorthand: a button-triggered sheet. */
export function Drawer({
  trigger,
  title,
  description,
  side,
  children,
  footer,
  open,
  onOpenChange,
}: {
  trigger?: React.ReactNode
  title: React.ReactNode
  description?: React.ReactNode
  side?: keyof typeof SIDE
  children: React.ReactNode
  footer?: React.ReactNode
  open?: boolean
  onOpenChange?: (o: boolean) => void
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger ? <SheetTrigger asChild>{trigger}</SheetTrigger> : null}
      <SheetContent side={side} title={title} description={description} footer={footer}>
        {children}
      </SheetContent>
    </Sheet>
  )
}
