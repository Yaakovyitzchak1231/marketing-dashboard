'use client'

import { useEffect } from 'react'
import { Toaster as Sonner, toast } from 'sonner'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

export { toast }

/** The app's one toaster (sonner, shadcn's toast). Mounted once in the shell. */
export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      offset={16}
      mobileOffset={{ bottom: 88 }}
      toastOptions={{
        classNames: {
          toast: 'rounded-card border border-line bg-surface text-ink shadow-overlay text-sm',
          description: 'text-ink-muted text-xs',
          actionButton: 'bg-accent text-on-accent',
        },
      }}
    />
  )
}

/**
 * Server actions that redirect with ?toast=<message> (or ?saved=1) get a
 * toast on arrival; the param is then removed from the URL.
 */
export function FlashToast() {
  const sp = useSearchParams()
  const router = useRouter()
  const pathname = usePathname()
  const msg = sp?.get('toast')
  useEffect(() => {
    if (!msg) return
    toast(msg)
    const next = new URLSearchParams(sp?.toString())
    next.delete('toast')
    const qs = next.toString()
    router.replace(`${pathname}${qs ? `?${qs}` : ''}`, { scroll: false })
  }, [msg, sp, router, pathname])
  return null
}
