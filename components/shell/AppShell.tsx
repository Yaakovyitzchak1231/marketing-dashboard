'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState, type ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { ChevronDown, LogOut, Menu, MessageSquareText, Monitor, Moon, MoreHorizontal, Search, Sparkles, Sun, UserRound, X } from 'lucide-react'
import { NAV_GROUPS, NAV_ITEMS, BOTTOM_NAV, activeHref, type NavItem } from './nav-config'
import { PreferencesProvider, usePreferences, type ThemePref } from './preferences'
import { CommandPalette, useCommandPaletteHotkey } from './CommandPalette'
import { useUnread } from '@/components/ops/LiveBell'
import { CopilotPanel } from '@/components/copilot/CopilotPanel'
import { Toaster, FlashToast } from '@/components/ui/Toast'
import { TableCards } from '@/components/ui/TableCards'
import { TooltipProvider } from '@/components/ui/Tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/DropdownMenu'
import { cn } from '@/components/ui/cn'

const OPS_KEY = 'tapdash.nav.opsOpen'

function badgeText(n: number): string {
  return n > 99 ? '99+' : String(n)
}

/** One nav row. The Inbox row carries the unread badge. */
function NavLink({ item, active, unread, onNavigate, dense }: { item: NavItem; active: boolean; unread: number | null; onNavigate?: () => void; dense?: boolean }) {
  const isInbox = item.href === '/inbox'
  return (
    <Link
      href={item.href}
      prefetch={false}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'group relative flex items-center gap-2.5 rounded-control px-2.5 text-sm transition-colors',
        dense ? 'h-9' : 'h-tap',
        active ? 'bg-surface font-semibold text-ink shadow-card' : 'text-ink-muted hover:bg-surface/70 hover:text-ink',
      )}
    >
      <span aria-hidden="true" className={cn('absolute -left-3 top-1.5 bottom-1.5 w-[3px] rounded-r-full', active ? 'bg-accent' : 'bg-transparent')} />
      <item.icon aria-hidden="true" className={cn('h-4 w-4 shrink-0', active ? 'text-accent' : 'text-ink-faint group-hover:text-ink-muted')} />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
      {isInbox && unread ? (
        <span data-testid="inbox-badge" aria-label={`${unread} unread`} className="inline-flex min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 py-px text-2xs font-semibold tabular-nums text-on-accent">
          {badgeText(unread)}
        </span>
      ) : null}
    </Link>
  )
}

/** All groups, for the rail and the phone drawer. */
function NavTree({ pathname, unread, onNavigate, dense }: { pathname: string; unread: number | null; onNavigate?: () => void; dense?: boolean }) {
  const current = activeHref(pathname)
  const opsActive = NAV_GROUPS.find((g) => g.id === 'ops')?.items.some((i) => i.href === current) ?? false
  const [opsOpen, setOpsOpen] = useState(false)
  useEffect(() => {
    try {
      setOpsOpen(window.localStorage.getItem(OPS_KEY) === '1')
    } catch {
      /* ignore */
    }
  }, [])
  const toggleOps = () => {
    setOpsOpen((o) => {
      try {
        window.localStorage.setItem(OPS_KEY, o ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !o
    })
  }
  return (
    <nav aria-label="Main" className="flex flex-col gap-5">
      {NAV_GROUPS.map((g) => {
        const open = !g.collapsible || opsOpen || opsActive
        return (
          <div key={g.id}>
            {g.title ? (
              g.collapsible ? (
                <button
                  type="button"
                  onClick={toggleOps}
                  aria-expanded={open}
                  aria-controls={`nav-group-${g.id}`}
                  className="mb-1 flex w-full items-center justify-between rounded-control px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.07em] text-ink-faint hover:text-ink-muted"
                >
                  {g.title}
                  <ChevronDown aria-hidden="true" className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-180')} />
                </button>
              ) : (
                <p className="mb-1 px-2.5 py-1 text-2xs font-semibold uppercase tracking-[0.07em] text-ink-faint">{g.title}</p>
              )
            ) : null}
            <ul id={`nav-group-${g.id}`} className={cn('flex flex-col gap-0.5', !open && 'hidden')}>
              {g.items.map((it) => (
                <li key={it.href}>
                  <NavLink item={it} active={current === it.href} unread={unread} onNavigate={onNavigate} dense={dense} />
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

function SearchButton({ onClick, className }: { onClick: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn('flex h-9 w-full items-center gap-2 rounded-control border border-line bg-surface px-2.5 text-sm text-ink-faint shadow-card hover:text-ink-muted', className)}
    >
      <Search aria-hidden="true" className="h-4 w-4" />
      <span className="flex-1 text-left">Search or jump to…</span>
      <kbd className="rounded border border-line px-1 text-2xs text-ink-faint">⌘K</kbd>
    </button>
  )
}

function AskButton({ onClick, className, label = 'Ask' }: { onClick: () => void; className?: string; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid="ask-button"
      className={cn('inline-flex items-center justify-center gap-1.5 rounded-control border border-accent/30 bg-accent-soft px-3 text-sm font-medium text-accent hover:border-accent/50', className)}
    >
      <Sparkles aria-hidden="true" className="h-4 w-4" />
      {label}
    </button>
  )
}

const THEMES: { id: ThemePref; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'Match device', icon: Monitor },
]

function UserMenu({ compact }: { compact?: boolean }) {
  const { theme, setTheme, reviewMode, setReviewMode } = usePreferences()
  const router = useRouter()
  const signOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' })
    } finally {
      router.push('/login')
      router.refresh()
    }
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account and preferences"
        className={cn(
          'flex items-center gap-2 rounded-control text-sm text-ink-muted hover:bg-surface/70 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
          compact ? 'h-tap w-tap justify-center' : 'h-10 w-full px-2.5',
        )}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <UserRound aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
        {compact ? null : <span className="min-w-0 flex-1 truncate text-left">Account</span>}
        {!compact && reviewMode ? <span className="rounded-full bg-warn-soft px-1.5 text-2xs font-semibold text-warn">Review</span> : null}
      </DropdownMenuTrigger>
      <DropdownMenuContent align={compact ? 'end' : 'start'} side={compact ? 'bottom' : 'top'} className="w-60">
        <DropdownMenuItem onSelect={() => router.push('/agents/owner')}>
          <UserRound aria-hidden="true" /> My profile & notifications
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel>Theme</DropdownMenuLabel>
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.id} onSelect={(e) => { e.preventDefault(); setTheme(t.id) }} aria-checked={theme === t.id} role="menuitemradio">
            <t.icon aria-hidden="true" />
            <span className="flex-1">{t.label}</span>
            {theme === t.id ? <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-accent" /> : null}
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={(e) => { e.preventDefault(); setReviewMode(!reviewMode) }} role="menuitemcheckbox" aria-checked={reviewMode} data-testid="review-mode-toggle">
          <MessageSquareText aria-hidden="true" />
          <span className="flex-1">Review mode</span>
          <span className={cn('relative inline-flex h-4 w-7 items-center rounded-full transition-colors', reviewMode ? 'bg-accent' : 'bg-line')}>
            <span className={cn('inline-block h-3 w-3 rounded-full bg-surface shadow transition-transform', reviewMode ? 'translate-x-3.5' : 'translate-x-0.5')} />
          </span>
        </DropdownMenuItem>
        <p className="px-2.5 pb-1.5 text-2xs leading-snug text-ink-faint">Pin comments for your agents on any page. Off by default.</p>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The sheet the copilot lives in: right side on desktop, full screen on phones. */
function CopilotSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-sheet bg-ink/20 animate-fade-in md:bg-ink/10" />
        <Dialog.Content
          data-testid="copilot-sheet"
          className="fixed inset-0 z-sheet flex flex-col bg-surface shadow-overlay animate-slide-in-right focus:outline-none md:inset-y-0 md:left-auto md:right-0 md:w-[440px] md:border-l md:border-line"
        >
          <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-3 pt-[calc(0.75rem+env(safe-area-inset-top))]">
            <Dialog.Title className="flex items-center gap-1.5 text-base font-semibold text-ink">
              <Sparkles aria-hidden="true" className="h-4 w-4 text-accent" /> Ask
            </Dialog.Title>
            <Dialog.Description className="sr-only">Ask questions about your leads, campaigns and replies.</Dialog.Description>
            <Dialog.Close className="inline-flex h-tap w-tap items-center justify-center rounded-control text-ink-muted hover:bg-surface-2 hover:text-ink">
              <X aria-hidden="true" className="h-5 w-5" />
              <span className="sr-only">Close</span>
            </Dialog.Close>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <CopilotPanel onClose={() => onOpenChange(false)} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

function ShellChrome({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  const unread = useUnread()
  const [drawer, setDrawer] = useState(false)
  const [palette, setPalette] = useState(false)
  const [ask, setAsk] = useState(false)
  const setPaletteFn = useCallback((fn: (o: boolean) => boolean) => setPalette(fn), [])
  useCommandPaletteHotkey(setPaletteFn)

  // A route change closes the drawer (adjusting state during render, not in an effect).
  const [lastPath, setLastPath] = useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setDrawer(false)
  }

  // While the drawer is open the comment layer's floating controls hide.
  useEffect(() => {
    const root = document.documentElement
    if (drawer) root.setAttribute('data-nav-menu-open', '')
    else root.removeAttribute('data-nav-menu-open')
    return () => root.removeAttribute('data-nav-menu-open')
  }, [drawer])

  const current = activeHref(pathname)
  const currentLabel = NAV_ITEMS.find((i) => i.href === current)?.label ?? ''

  return (
    <div className="min-h-dvh lg:pl-rail">
      {/* Desktop side rail */}
      <aside data-shell-chrome="" aria-label="Sidebar" className="fixed inset-y-0 left-0 z-rail hidden w-rail flex-col border-r border-line bg-surface-2 lg:flex print:hidden">
        <div className="flex items-center justify-between px-5 pb-3 pt-5">
          <Link href="/" prefetch={false} className="flex items-center gap-2 text-base font-semibold tracking-[-0.01em] text-ink">
            <span aria-hidden="true" className="flex h-6 w-6 items-center justify-center rounded-[7px] bg-accent text-2xs font-bold text-on-accent">T</span>
            TapDash
          </Link>
        </div>
        <div className="flex gap-2 px-3 pb-3">
          <SearchButton onClick={() => setPalette(true)} />
        </div>
        <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-3 pb-4 pl-3">
          <NavTree pathname={pathname} unread={unread} dense />
        </div>
        <div className="flex flex-col gap-1.5 border-t border-line px-3 py-3">
          <AskButton onClick={() => setAsk(true)} className="h-9 w-full" label="Ask the assistant" />
          <UserMenu />
        </div>
      </aside>

      {/* Phone / tablet top bar */}
      <header data-shell-chrome="" className="sticky top-0 z-bar flex h-14 items-center gap-1 border-b border-line bg-canvas/90 px-2 backdrop-blur supports-[backdrop-filter]:bg-canvas/80 lg:hidden print:hidden">
        <button
          type="button"
          onClick={() => setDrawer(true)}
          aria-label="Open menu"
          aria-expanded={drawer}
          aria-controls="nav-drawer"
          className="inline-flex h-tap w-tap items-center justify-center rounded-control text-ink hover:bg-surface-2"
        >
          <Menu aria-hidden="true" className="h-5 w-5" />
        </button>
        <Link href="/" prefetch={false} className="shrink-0 px-1 text-base font-semibold tracking-[-0.01em] text-ink">
          TapDash
        </Link>
        {currentLabel && current !== '/' ? (
          <span className="min-w-0 flex-1 truncate text-sm text-ink-muted" aria-hidden="true">
            <span className="mx-1 text-line">/</span>
            {currentLabel}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        <button type="button" onClick={() => setPalette(true)} aria-label="Search" className="inline-flex h-tap w-tap items-center justify-center rounded-control text-ink-muted hover:bg-surface-2 hover:text-ink">
          <Search aria-hidden="true" className="h-5 w-5" />
        </button>
        <AskButton onClick={() => setAsk(true)} className="hidden h-9 sm:inline-flex" />
        <UserMenu compact />
      </header>

      {/* Phone / tablet drawer */}
      <Dialog.Root open={drawer} onOpenChange={setDrawer}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-sheet bg-ink/30 animate-fade-in lg:hidden" />
          <Dialog.Content id="nav-drawer" className="fixed inset-y-0 left-0 z-sheet flex w-[86vw] max-w-[320px] flex-col bg-surface-2 shadow-overlay animate-fade-in focus:outline-none lg:hidden">
            <div className="flex items-center justify-between px-4 pb-2 pt-[calc(0.75rem+env(safe-area-inset-top))]">
              <Dialog.Title className="text-base font-semibold text-ink">TapDash</Dialog.Title>
              <Dialog.Description className="sr-only">Every screen, grouped.</Dialog.Description>
              <Dialog.Close className="inline-flex h-tap w-tap items-center justify-center rounded-control text-ink-muted hover:text-ink">
                <X aria-hidden="true" className="h-5 w-5" />
                <span className="sr-only">Close menu</span>
              </Dialog.Close>
            </div>
            <div className="px-4 pb-3">
              <SearchButton onClick={() => { setDrawer(false); setPalette(true) }} className="h-tap" />
            </div>
            <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-4 pb-[calc(1rem+env(safe-area-inset-bottom))]">
              <NavTree pathname={pathname} unread={unread} onNavigate={() => setDrawer(false)} />
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {children}

      {/* Phone bottom nav */}
      <nav data-shell-chrome="" aria-label="Quick" className="fixed inset-x-0 bottom-0 z-bar border-t border-line bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden print:hidden">
        <ul className="grid grid-cols-6">
          {BOTTOM_NAV.map((href) => {
            const it = NAV_ITEMS.find((i) => i.href === href)!
            const on = current === href
            return (
              <li key={href} className={href === '/' ? '' : ''}>
                <Link
                  href={href}
                  prefetch={false}
                  aria-current={on ? 'page' : undefined}
                  className={cn('relative flex h-14 flex-col items-center justify-center gap-0.5 text-2xs font-medium', on ? 'text-accent' : 'text-ink-muted')}
                >
                  <it.icon aria-hidden="true" className="h-5 w-5" />
                  {it.label}
                  {href === '/inbox' && unread ? (
                    <span aria-label={`${unread} unread`} className="absolute right-[18%] top-1.5 inline-flex min-w-[16px] items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-4 text-on-accent">
                      {badgeText(unread)}
                    </span>
                  ) : null}
                </Link>
              </li>
            )
          })}
          <li>
            <button type="button" onClick={() => setAsk(true)} className="flex h-14 w-full flex-col items-center justify-center gap-0.5 text-2xs font-medium text-ink-muted">
              <Sparkles aria-hidden="true" className="h-5 w-5 text-accent" />
              Ask
            </button>
          </li>
          <li>
            <button type="button" onClick={() => setDrawer(true)} className="flex h-14 w-full flex-col items-center justify-center gap-0.5 text-2xs font-medium text-ink-muted">
              <MoreHorizontal aria-hidden="true" className="h-5 w-5" />
              More
            </button>
          </li>
        </ul>
      </nav>

      <CommandPalette open={palette} onOpenChange={setPalette} onAsk={() => setAsk(true)} />
      <CopilotSheet open={ask} onOpenChange={setAsk} />
      <TableCards />
    </div>
  )
}

/**
 * The app frame: grouped side rail on desktop; top bar, drawer and bottom
 * nav on phones; command palette (Cmd/Ctrl-K); the copilot sheet; toasts.
 * The login page renders bare.
 */
export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? '/'
  return (
    <PreferencesProvider>
      <TooltipProvider delayDuration={250}>
        {pathname === '/login' ? children : <ShellChrome>{children}</ShellChrome>}
        <Toaster />
        <Suspense fallback={null}>
          <FlashToast />
        </Suspense>
      </TooltipProvider>
    </PreferencesProvider>
  )
}
