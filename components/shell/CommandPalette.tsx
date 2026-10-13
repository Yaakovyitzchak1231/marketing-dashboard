'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Command } from 'cmdk'
import * as Dialog from '@radix-ui/react-dialog'
import { ArrowRight, Moon, MessageSquareText, Search, Sun, Users } from 'lucide-react'
import { NAV_GROUPS, PALETTE_EXTRAS } from './nav-config'
import { usePreferences } from './preferences'

const ITEM =
  'flex cursor-pointer select-none items-center gap-2.5 rounded-control px-3 py-2.5 text-sm text-ink outline-none data-[selected=true]:bg-surface-2 [&_svg]:h-4 [&_svg]:w-4 [&_svg]:shrink-0 [&_svg]:text-ink-faint'
const GROUP = '[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-[0.06em] [&_[cmdk-group-heading]]:text-ink-faint'

/** Opens on Cmd/Ctrl-K or the "open-command-palette" window event. */
export function useCommandPaletteHotkey(setOpen: (fn: (o: boolean) => boolean) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    const onOpen = () => setOpen(() => true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('open-command-palette', onOpen)
    return () => {
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('open-command-palette', onOpen)
    }
  }, [setOpen])
}

/**
 * Global command palette (cmdk): jump to any page, run a common action, or
 * search leads by name, email or website.
 */
export function CommandPalette({ open, onOpenChange, onAsk }: { open: boolean; onOpenChange: (o: boolean) => void; onAsk?: () => void }) {
  const router = useRouter()
  const [query, setQuery] = useState('')
  const { theme, setTheme, reviewMode, setReviewMode } = usePreferences()

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const go = (href: string) => {
    onOpenChange(false)
    router.push(href)
  }
  const q = query.trim()

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-palette bg-ink/30 backdrop-blur-[1px] animate-fade-in" />
        <Dialog.Content className="fixed inset-x-3 top-[10vh] z-palette mx-auto max-w-xl overflow-hidden rounded-sheet border border-line bg-surface shadow-overlay animate-fade-in focus:outline-none">
          <Dialog.Title className="sr-only">Jump to a page or search leads</Dialog.Title>
          <Command label="Command palette" className="flex max-h-[70vh] flex-col">
            <div className="flex items-center gap-2 border-b border-line-soft px-4">
              <Search aria-hidden="true" className="h-4 w-4 shrink-0 text-ink-faint" />
              <Command.Input
                value={query}
                onValueChange={setQuery}
                placeholder="Jump to a page, run an action, or search leads…"
                className="h-12 w-full bg-transparent text-base text-ink outline-none placeholder:text-ink-faint"
              />
              <kbd className="hidden shrink-0 rounded border border-line px-1.5 py-0.5 text-2xs text-ink-faint sm:inline">Esc</kbd>
            </div>
            <Command.List className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-ink-muted">No matching page. Press Enter to search leads.</Command.Empty>
              {q ? (
                <Command.Group heading="Leads" className={GROUP} forceMount>
                  <Command.Item value={`search leads ${q}`} onSelect={() => go(`/leads?q=${encodeURIComponent(q)}`)} className={ITEM} forceMount>
                    <Users aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">
                      Search leads for “<span className="font-medium">{q}</span>”
                    </span>
                    <ArrowRight aria-hidden="true" />
                  </Command.Item>
                </Command.Group>
              ) : null}
              {NAV_GROUPS.map((g) => (
                <Command.Group key={g.id} heading={g.title ?? 'Go to'} className={GROUP}>
                  {g.items.map((it) => (
                    <Command.Item key={it.href} value={`${it.label} ${it.keywords ?? ''}`} onSelect={() => go(it.href)} className={ITEM}>
                      <it.icon aria-hidden="true" />
                      {it.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              {(['Actions', 'Pages'] as const).map((grp) => (
                <Command.Group key={grp} heading={grp === 'Pages' ? 'More pages' : grp} className={GROUP}>
                  {PALETTE_EXTRAS.filter((x) => x.group === grp).map((x) => (
                    <Command.Item key={x.href + x.label} value={`${x.label} ${x.keywords ?? ''}`} onSelect={() => go(x.href)} className={ITEM}>
                      <ArrowRight aria-hidden="true" />
                      {x.label}
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}
              <Command.Group heading="Preferences" className={GROUP}>
                {onAsk ? (
                  <Command.Item value="ask assistant copilot question" onSelect={() => { onOpenChange(false); onAsk() }} className={ITEM}>
                    <MessageSquareText aria-hidden="true" />
                    Ask the assistant
                  </Command.Item>
                ) : null}
                <Command.Item value="theme dark light mode" onSelect={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className={ITEM}>
                  {theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}
                  {theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
                </Command.Item>
                <Command.Item value="review mode comments pins" onSelect={() => setReviewMode(!reviewMode)} className={ITEM}>
                  <MessageSquareText aria-hidden="true" />
                  {reviewMode ? 'Turn off Review mode' : 'Turn on Review mode (page comments)'}
                </Command.Item>
              </Command.Group>
            </Command.List>
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
