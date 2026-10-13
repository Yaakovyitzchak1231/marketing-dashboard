import * as React from 'react'
import Link from 'next/link'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './cn'

/** shadcn/ui Button, on this project's tokens. One primary, one secondary, ghost, destructive. */
export const buttonVariants = cva(
  'inline-flex select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-control font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 focus-visible:ring-offset-1 focus-visible:ring-offset-canvas disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        primary: 'border border-accent bg-accent text-on-accent shadow-card hover:border-accent-strong hover:bg-accent-strong',
        secondary: 'border border-line bg-surface text-ink shadow-card hover:border-ink-faint/60 hover:bg-surface-2',
        ghost: 'border border-transparent bg-transparent text-ink-muted hover:bg-surface-2 hover:text-ink',
        destructive: 'border border-bad/40 bg-surface text-bad shadow-card hover:border-bad/60 hover:bg-bad-soft',
      },
      size: {
        sm: 'h-8 px-2.5 text-xs',
        md: 'h-9 px-3.5 text-sm max-md:min-h-tap',
        lg: 'h-11 px-5 text-base',
        icon: 'h-9 w-9 max-md:h-tap max-md:w-tap',
      },
      block: { true: 'w-full', false: '' },
    },
    defaultVariants: { variant: 'secondary', size: 'md', block: false },
  },
)

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>

/** The one button class string, for <button>, <Link> and <a> alike. */
export function buttonClass(opts: { variant?: ButtonVariant; size?: ButtonSize; block?: boolean } = {}): string {
  return buttonVariants(opts)
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, block, asChild = false, type, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'button'
  return <Comp ref={ref} type={asChild ? undefined : (type ?? 'button')} className={cn(buttonVariants({ variant, size, block }), className)} {...props} />
})

export function ButtonLink({
  href,
  variant,
  size,
  block,
  className,
  children,
  prefetch = false,
  ...props
}: Omit<React.AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & VariantProps<typeof buttonVariants> & { href: string; prefetch?: boolean; children: React.ReactNode }) {
  return (
    <Link href={href} prefetch={prefetch} className={cn(buttonVariants({ variant, size, block }), className)} {...props}>
      {children}
    </Link>
  )
}

/** Inline text link ("View all", "Details"). */
export const linkClass = 'font-medium text-accent underline-offset-2 hover:underline focus-visible:underline'
