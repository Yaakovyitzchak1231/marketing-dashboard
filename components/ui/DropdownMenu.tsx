'use client'

import * as React from 'react'
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu'
import { Check } from 'lucide-react'
import { cn } from './cn'

/** shadcn DropdownMenu (Radix). */
export const DropdownMenu = DropdownMenuPrimitive.Root
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger
export const DropdownMenuGroup = DropdownMenuPrimitive.Group

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn('z-palette min-w-[12rem] overflow-hidden rounded-card border border-line bg-surface p-1 text-sm text-ink shadow-overlay animate-fade-in', className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  )
})

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>
>(function DropdownMenuItem({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      className={cn('relative flex cursor-pointer select-none items-center gap-2 rounded-control px-2.5 py-2 text-sm outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-surface-2 data-[disabled]:opacity-50 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:text-ink-faint', className)}
      {...props}
    />
  )
})

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      className={cn('relative flex cursor-pointer select-none items-center rounded-control py-2 pl-8 pr-2.5 text-sm outline-none data-[highlighted]:bg-surface-2', className)}
      {...props}
    >
      <span className="absolute left-2.5 flex h-4 w-4 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="h-4 w-4 text-accent" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  )
})

export function DropdownMenuLabel({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn('px-2.5 py-1.5 text-2xs font-semibold uppercase tracking-[0.06em] text-ink-faint', className)} {...props} />
}

export function DropdownMenuSeparator({ className, ...props }: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>) {
  return <DropdownMenuPrimitive.Separator className={cn('-mx-1 my-1 h-px bg-line-soft', className)} {...props} />
}
